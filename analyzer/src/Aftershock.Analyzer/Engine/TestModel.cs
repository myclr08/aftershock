using System.Collections.Concurrent;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.FindSymbols;

namespace Aftershock.Analyzer.Engine;

public sealed record TestMethodInfo(string Framework, bool Parameterized);

/// <summary>
/// Knowledge about xUnit (v2 and v3), NUnit and MSTest: what a test method is, which members run for every
/// test of a class, and which members feed tests indirectly (fixtures, data sources).
/// Attribute types are matched by name (with or without the "Attribute" suffix) along the attribute's base
/// types, so custom attributes such as <c>[SkippableFact]</c> or <c>[AutoData]</c>-style theories are recognized.
/// </summary>
public sealed class TestModel
{
    private static readonly HashSet<string> TestAttributes = new(StringComparer.Ordinal)
    {
        "Fact", "Theory", "Test", "TestCase", "TestCaseSource", "TestMethod", "DataTestMethod",
    };

    private static readonly HashSet<string> ClassLifecycleAttributes = new(StringComparer.Ordinal)
    {
        "SetUp", "TearDown", "OneTimeSetUp", "OneTimeTearDown", "TestFixtureSetUp", "TestFixtureTearDown",
        "TestInitialize", "TestCleanup", "ClassInitialize", "ClassCleanup",
    };

    private static readonly HashSet<string> AssemblyLifecycleAttributes = new(StringComparer.Ordinal)
    {
        "AssemblyInitialize", "AssemblyCleanup",
    };

    private static readonly HashSet<string> LifecycleMethodNames = new(StringComparer.Ordinal)
    {
        "Dispose", "DisposeAsync", "InitializeAsync",
    };

    // Constructor parameters supplied by the frameworks themselves; they are not fixtures.
    private static readonly HashSet<string> FrameworkInjectedTypes = new(StringComparer.Ordinal)
    {
        "ITestOutputHelper", "IMessageSink", "ITestContextAccessor", "TestContext", "ITestContext", "CancellationToken",
    };

    private static readonly HashSet<string> SetUpFixtureAttribute = new(StringComparer.Ordinal) { "SetUpFixture" };

    private static readonly SymbolEqualityComparer Comparer = SymbolEqualityComparer.Default;

    private readonly Solution _solution;
    private readonly AnalysisLog _log;
    private readonly ConcurrentDictionary<ISymbol, TestMethodInfo?> _testInfo = new(Comparer);
    private readonly ConcurrentDictionary<ISymbol, Task<IReadOnlyList<INamedTypeSymbol>>> _runnable = new(Comparer);
    private readonly ConcurrentDictionary<ISymbol, IReadOnlyList<IMethodSymbol>> _testMethods = new(Comparer);
    private readonly Lazy<Task<TestIndexes>> _indexes;

    public TestModel(Solution solution, SolutionModel solutionModel, AnalysisLog log)
    {
        _solution = solution;
        _log = log;
        SolutionModel = solutionModel;
        _indexes = new Lazy<Task<TestIndexes>>(() => BuildIndexesAsync(CancellationToken.None), LazyThreadSafetyMode.ExecutionAndPublication);
    }

    public SolutionModel SolutionModel { get; }

    /// <summary>Returns framework information when <paramref name="symbol"/> is a test method.</summary>
    public TestMethodInfo? GetTestInfo(ISymbol symbol)
    {
        if (symbol is not IMethodSymbol { MethodKind: MethodKind.Ordinary } method)
        {
            return null;
        }

        return _testInfo.GetOrAdd(method.OriginalDefinition, static (s, self) => self.ComputeTestInfo((IMethodSymbol)s), this);
    }

    public bool IsTestMethod(ISymbol symbol) => GetTestInfo(symbol) is not null;

    /// <summary>Members that run for every test of their class: constructors, setup/teardown, Dispose, IAsyncLifetime.</summary>
    public static bool IsClassLifecycle(ISymbol symbol)
    {
        if (symbol is not IMethodSymbol method)
        {
            return false;
        }

        switch (method.MethodKind)
        {
            case MethodKind.Constructor:
            case MethodKind.StaticConstructor:
            case MethodKind.Destructor:
                return true;
            case MethodKind.Ordinary:
            case MethodKind.ExplicitInterfaceImplementation:
                if (HasAttribute(method, ClassLifecycleAttributes) is not null)
                {
                    return true;
                }

                if (method.Parameters.Length == 0 && !method.IsStatic)
                {
                    if (LifecycleMethodNames.Contains(method.Name))
                    {
                        return true;
                    }

                    return method.ExplicitInterfaceImplementations.Any(i => LifecycleMethodNames.Contains(i.Name));
                }

                return false;
            default:
                return false;
        }
    }

    /// <summary>MSTest [AssemblyInitialize]/[AssemblyCleanup] and members of NUnit [SetUpFixture] classes.</summary>
    public static bool IsAssemblyLifecycle(ISymbol symbol)
    {
        if (symbol is not IMethodSymbol method)
        {
            return false;
        }

        if (HasAttribute(method, AssemblyLifecycleAttributes) is not null)
        {
            return true;
        }

        return method.ContainingType is { } type
            && HasAttribute(type, SetUpFixtureAttribute) is not null
            && IsClassLifecycle(method);
    }

    /// <summary>
    /// Concrete classes whose tests run when code of <paramref name="type"/> runs for every test:
    /// the type itself and all derived classes that are not abstract and contain at least one test.
    /// </summary>
    public Task<IReadOnlyList<INamedTypeSymbol>> GetRunnableClassesAsync(INamedTypeSymbol type, CancellationToken cancellationToken)
    {
        return _runnable.GetOrAdd(type.OriginalDefinition, _ => ComputeRunnableClassesAsync(type.OriginalDefinition, cancellationToken));
    }

    /// <summary>All test methods that run for a concrete class, including inherited ones.</summary>
    public IReadOnlyList<IMethodSymbol> GetTestMethods(INamedTypeSymbol concreteClass)
    {
        return _testMethods.GetOrAdd(concreteClass.OriginalDefinition, s => ComputeTestMethods((INamedTypeSymbol)s));
    }

    public Task<TestIndexes> GetIndexesAsync() => _indexes.Value;

    internal static AttributeData? HasAttribute(ISymbol symbol, HashSet<string> names)
    {
        foreach (var attribute in symbol.GetAttributes())
        {
            if (MatchAttribute(attribute, names) is not null)
            {
                return attribute;
            }
        }

        return null;
    }

    /// <summary>Returns the matched short name (e.g. "Theory") when the attribute or one of its base types is in <paramref name="names"/>.</summary>
    internal static string? MatchAttribute(AttributeData attribute, HashSet<string> names)
    {
        for (var type = attribute.AttributeClass; type is not null; type = type.BaseType)
        {
            var name = ShortAttributeName(type.Name);
            if (names.Contains(name))
            {
                return name;
            }

            if (type.TypeKind == TypeKind.Error)
            {
                break;
            }
        }

        return null;
    }

    internal static string ShortAttributeName(string name)
    {
        return name.EndsWith("Attribute", StringComparison.Ordinal) && name.Length > "Attribute".Length
            ? name[..^"Attribute".Length]
            : name;
    }

    private TestMethodInfo? ComputeTestInfo(IMethodSymbol method)
    {
        foreach (var attribute in method.GetAttributes())
        {
            var matched = MatchAttribute(attribute, TestAttributes);
            if (matched is null)
            {
                continue;
            }

            var framework = FrameworkOf(attribute, matched, method);
            return new TestMethodInfo(framework, IsParameterized(method, framework));
        }

        // An override of a test method stays a test (the frameworks inherit method attributes).
        if (method.IsOverride && method.OverriddenMethod is { } overridden)
        {
            return GetTestInfo(overridden);
        }

        return null;
    }

    private string FrameworkOf(AttributeData attribute, string matchedName, IMethodSymbol method)
    {
        for (var type = attribute.AttributeClass; type is not null && type.TypeKind != TypeKind.Error; type = type.BaseType)
        {
            var ns = type.ContainingNamespace?.ToDisplayString() ?? string.Empty;
            if (ns.StartsWith("Xunit", StringComparison.Ordinal))
            {
                return "xunit";
            }

            if (ns.StartsWith("NUnit.Framework", StringComparison.Ordinal))
            {
                return "nunit";
            }

            if (ns.StartsWith("Microsoft.VisualStudio.TestTools.UnitTesting", StringComparison.Ordinal))
            {
                return "mstest";
            }
        }

        // Unresolved attribute (missing restore) or a custom attribute outside the framework namespaces.
        var project = _solution.GetProject(method.ContainingAssembly);
        var frameworks = project is null ? Array.Empty<string>() : SolutionModel.FrameworksOf(project);
        if (frameworks.Count == 1)
        {
            return frameworks[0];
        }

        return matchedName switch
        {
            "Fact" or "Theory" => "xunit",
            "Test" or "TestCase" or "TestCaseSource" => "nunit",
            _ => "mstest",
        };
    }

    private static bool IsParameterized(IMethodSymbol method, string framework)
    {
        var names = method.GetAttributes().Select(a => a.AttributeClass).Where(c => c is not null).SelectMany(Chain).ToHashSet(StringComparer.Ordinal);
        return framework switch
        {
            "xunit" => names.Contains("Theory"),
            "nunit" => names.Contains("TestCase") || names.Contains("TestCaseSource") || names.Contains("Theory") || method.Parameters.Length > 0,
            _ => names.Contains("DataTestMethod") || names.Contains("DataRow") || names.Contains("DynamicData") || method.Parameters.Length > 0,
        };

        static IEnumerable<string> Chain(INamedTypeSymbol? type)
        {
            for (; type is not null; type = type.BaseType)
            {
                yield return ShortAttributeName(type.Name);
                if (type.TypeKind == TypeKind.Error)
                {
                    yield break;
                }
            }
        }
    }

    private async Task<IReadOnlyList<INamedTypeSymbol>> ComputeRunnableClassesAsync(INamedTypeSymbol type, CancellationToken cancellationToken)
    {
        if (type.TypeKind != TypeKind.Class)
        {
            return Array.Empty<INamedTypeSymbol>();
        }

        var candidates = new List<INamedTypeSymbol> { type };
        if (!type.IsSealed && !type.IsStatic)
        {
            var derived = await SymbolFinder.FindDerivedClassesAsync(type, _solution, transitive: true, cancellationToken: cancellationToken).ConfigureAwait(false);
            candidates.AddRange(derived);
        }

        return candidates
            .Select(c => c.OriginalDefinition)
            .Distinct<INamedTypeSymbol>(Comparer)
            .Where(c => !c.IsAbstract && !(c.IsGenericType && c.TypeArguments.Any(a => a is ITypeParameterSymbol)))
            .Where(c => GetTestMethods(c).Count > 0)
            .OrderBy(c => FullName(c), StringComparer.Ordinal)
            .ToList();
    }

    private IReadOnlyList<IMethodSymbol> ComputeTestMethods(INamedTypeSymbol type)
    {
        var result = new List<IMethodSymbol>();
        var overridden = new HashSet<IMethodSymbol>(Comparer);
        for (var current = type; current is not null && current.SpecialType != SpecialType.System_Object; current = current.BaseType)
        {
            foreach (var method in current.GetMembers().OfType<IMethodSymbol>())
            {
                if (method.MethodKind != MethodKind.Ordinary || overridden.Contains(method.OriginalDefinition))
                {
                    continue;
                }

                for (var o = method.OverriddenMethod; o is not null; o = o.OverriddenMethod)
                {
                    overridden.Add(o.OriginalDefinition);
                }

                if (!method.IsAbstract && IsTestMethod(method))
                {
                    result.Add(method.OriginalDefinition);
                }
            }
        }

        return result;
    }

    /// <summary>Metadata-style full name used by the VSTest adapters: <c>Ns.Outer+Inner</c>.</summary>
    public static string FullName(INamedTypeSymbol type)
    {
        var parts = new Stack<string>();
        for (var t = type; t is not null; t = t.ContainingType)
        {
            parts.Push(t.MetadataName);
        }

        var ns = type.ContainingNamespace is { IsGlobalNamespace: false } n ? n.ToDisplayString() + "." : string.Empty;
        return ns + string.Join("+", parts);
    }

    private async Task<TestIndexes> BuildIndexesAsync(CancellationToken cancellationToken)
    {
        var indexes = new TestIndexes();
        var collectionDefinitions = new List<(INamedTypeSymbol Definition, string? Name, List<ITypeSymbol> Fixtures)>();
        var collectionUsersByName = new Dictionary<string, List<INamedTypeSymbol>>(StringComparer.Ordinal);
        var collectionUsersByType = new Dictionary<ISymbol, List<INamedTypeSymbol>>(Comparer);

        foreach (var project in SolutionModel.TestProjects(_solution))
        {
            var compilation = await project.GetCompilationAsync(cancellationToken).ConfigureAwait(false);
            if (compilation is null)
            {
                continue;
            }

            foreach (var attribute in compilation.Assembly.GetAttributes())
            {
                if (attribute.AttributeClass is { } attributeClass && ShortAttributeName(attributeClass.Name) == "AssemblyFixture")
                {
                    foreach (var fixture in TypeArguments(attribute))
                    {
                        indexes.Add(indexes.AssemblyFixtures, fixture, project.Id);
                    }
                }
            }

            foreach (var type in SourceTypes(compilation.Assembly.GlobalNamespace))
            {
                cancellationToken.ThrowIfCancellationRequested();
                IndexType(type, indexes, collectionDefinitions, collectionUsersByName, collectionUsersByType);
            }
        }

        foreach (var (definition, name, fixtures) in collectionDefinitions)
        {
            var users = new List<INamedTypeSymbol>();
            if (collectionUsersByType.TryGetValue(definition, out var byType))
            {
                users.AddRange(byType);
            }

            if (name is not null && collectionUsersByName.TryGetValue(name, out var byName))
            {
                users.AddRange(byName);
            }

            foreach (var fixture in fixtures)
            {
                foreach (var user in users)
                {
                    indexes.Add(indexes.FixtureUsers, fixture, user);
                }
            }
        }

        _log.Debug($"test index: {indexes.FixtureUsers.Count} fixture types, {indexes.DataMemberUsers.Count} data members, {indexes.DataClassUsers.Count} data classes, {indexes.AssemblyFixtures.Count} assembly fixtures");
        return indexes;
    }

    private void IndexType(
        INamedTypeSymbol type,
        TestIndexes indexes,
        List<(INamedTypeSymbol Definition, string? Name, List<ITypeSymbol> Fixtures)> collectionDefinitions,
        Dictionary<string, List<INamedTypeSymbol>> collectionUsersByName,
        Dictionary<ISymbol, List<INamedTypeSymbol>> collectionUsersByType)
    {
        foreach (var iface in type.AllInterfaces)
        {
            if (iface.Name == "IClassFixture" && iface.TypeArguments.Length == 1)
            {
                indexes.Add(indexes.FixtureUsers, iface.TypeArguments[0], type);
            }
        }

        foreach (var attribute in type.GetAttributes())
        {
            var name = attribute.AttributeClass is null ? null : ShortAttributeName(attribute.AttributeClass.Name);
            switch (name)
            {
                case "CollectionDefinition":
                    var fixtures = type.AllInterfaces
                        .Where(i => i.Name == "ICollectionFixture" && i.TypeArguments.Length == 1)
                        .Select(i => i.TypeArguments[0])
                        .ToList();
                    collectionDefinitions.Add((type, StringArguments(attribute).FirstOrDefault(), fixtures));
                    break;
                case "Collection":
                    foreach (var collectionName in StringArguments(attribute))
                    {
                        Add(collectionUsersByName, collectionName, type);
                    }

                    foreach (var definition in TypeArguments(attribute))
                    {
                        if (!collectionUsersByType.TryGetValue(definition.OriginalDefinition, out var list))
                        {
                            collectionUsersByType[definition.OriginalDefinition] = list = new List<INamedTypeSymbol>();
                        }

                        list.Add(type);
                    }

                    break;
                case "TestFixtureSource":
                    IndexDataSource(attribute, type, null, type, indexes);
                    break;
            }
        }

        var testMethods = type.GetMembers().OfType<IMethodSymbol>().Where(IsTestMethod).ToList();
        var isTestClass = testMethods.Count > 0 || (!type.IsAbstract && GetTestMethods(type).Count > 0);
        if (isTestClass)
        {
            foreach (var constructor in type.InstanceConstructors)
            {
                foreach (var parameter in constructor.Parameters)
                {
                    if (parameter.Type is INamedTypeSymbol parameterType
                        && parameterType.SpecialType == SpecialType.None
                        && parameterType.TypeKind is TypeKind.Class or TypeKind.Interface or TypeKind.Struct
                        && !FrameworkInjectedTypes.Contains(parameterType.Name))
                    {
                        indexes.Add(indexes.FixtureUsers, parameterType, type);
                    }
                }
            }
        }

        foreach (var method in testMethods)
        {
            foreach (var attribute in method.GetAttributes())
            {
                IndexDataSource(attribute, method.ContainingType, method, null, indexes);
            }

            foreach (var parameter in method.Parameters)
            {
                foreach (var attribute in parameter.GetAttributes())
                {
                    IndexDataSource(attribute, method.ContainingType, method, null, indexes);
                }
            }
        }
    }

    private static void IndexDataSource(AttributeData attribute, INamedTypeSymbol declaringType, IMethodSymbol? method, INamedTypeSymbol? fixtureClass, TestIndexes indexes)
    {
        var name = attribute.AttributeClass is null ? null : ShortAttributeName(attribute.AttributeClass.Name);
        if (name is not ("MemberData" or "ClassData" or "TestCaseSource" or "ValueSource" or "DynamicData" or "TestFixtureSource"))
        {
            return;
        }

        var memberName = StringArguments(attribute).FirstOrDefault();
        ITypeSymbol? sourceType = null;
        foreach (var named in attribute.NamedArguments)
        {
            if (named.Key == "MemberType" && named.Value.Value is ITypeSymbol memberType)
            {
                sourceType = memberType;
            }
        }

        sourceType ??= TypeArguments(attribute).FirstOrDefault();

        if (memberName is null)
        {
            if (sourceType is null)
            {
                return;
            }

            // [ClassData(typeof(T))], [TestCaseSource(typeof(T))]: any member of T feeds the test.
            if (method is not null)
            {
                indexes.Add(indexes.DataClassUsers, sourceType, method);
            }
            else if (fixtureClass is not null)
            {
                indexes.Add(indexes.ClassSourceTypeUsers, sourceType, fixtureClass);
            }

            return;
        }

        var lookupType = sourceType as INamedTypeSymbol ?? declaringType;
        foreach (var member in LookupMembers(lookupType, memberName))
        {
            if (method is not null)
            {
                indexes.Add(indexes.DataMemberUsers, member, method);
            }
            else if (fixtureClass is not null)
            {
                indexes.Add(indexes.ClassSourceUsers, member, fixtureClass);
            }
        }
    }

    private static IEnumerable<ISymbol> LookupMembers(INamedTypeSymbol type, string name)
    {
        for (var current = type; current is not null; current = current.BaseType)
        {
            var members = current.GetMembers(name).Where(m => m is IPropertySymbol or IMethodSymbol or IFieldSymbol).ToList();
            if (members.Count > 0)
            {
                return members;
            }
        }

        return Array.Empty<ISymbol>();
    }

    private static IEnumerable<string> StringArguments(AttributeData attribute)
    {
        foreach (var argument in attribute.ConstructorArguments)
        {
            if (argument.Kind == TypedConstantKind.Primitive && argument.Value is string value)
            {
                yield return value;
            }
        }
    }

    /// <summary>typeof(T) constructor arguments plus generic attribute type arguments (xUnit v3 <c>[Collection&lt;T&gt;]</c>).</summary>
    private static IEnumerable<ITypeSymbol> TypeArguments(AttributeData attribute)
    {
        foreach (var argument in attribute.ConstructorArguments)
        {
            if (argument.Kind == TypedConstantKind.Type && argument.Value is ITypeSymbol type)
            {
                yield return type;
            }
        }

        if (attribute.AttributeClass is { IsGenericType: true } generic)
        {
            foreach (var typeArgument in generic.TypeArguments)
            {
                yield return typeArgument;
            }
        }
    }

    private static IEnumerable<INamedTypeSymbol> SourceTypes(INamespaceSymbol ns)
    {
        foreach (var member in ns.GetMembers())
        {
            if (member is INamespaceSymbol child)
            {
                foreach (var type in SourceTypes(child))
                {
                    yield return type;
                }
            }
            else if (member is INamedTypeSymbol type && type.Locations.Any(l => l.IsInSource))
            {
                foreach (var nested in WithNested(type))
                {
                    yield return nested;
                }
            }
        }

        static IEnumerable<INamedTypeSymbol> WithNested(INamedTypeSymbol type)
        {
            yield return type;
            foreach (var nested in type.GetTypeMembers())
            {
                foreach (var inner in WithNested(nested))
                {
                    yield return inner;
                }
            }
        }
    }

    private static void Add<TKey, TValue>(Dictionary<TKey, List<TValue>> map, TKey key, TValue value)
        where TKey : notnull
    {
        if (!map.TryGetValue(key, out var list))
        {
            map[key] = list = new List<TValue>();
        }

        list.Add(value);
    }
}

/// <summary>Indirect links from code to tests that are not visible as symbol references.</summary>
public sealed class TestIndexes
{
    private static readonly SymbolEqualityComparer Comparer = SymbolEqualityComparer.Default;

    /// <summary>Fixture/injected type → test classes constructed with it (IClassFixture, collection fixtures, constructor injection).</summary>
    public Dictionary<ISymbol, List<INamedTypeSymbol>> FixtureUsers { get; } = new(Comparer);

    /// <summary>xUnit v3 assembly fixture type → test projects.</summary>
    public Dictionary<ISymbol, List<ProjectId>> AssemblyFixtures { get; } = new(Comparer);

    /// <summary>Data member (MemberData/TestCaseSource/ValueSource/DynamicData by name) → test methods.</summary>
    public Dictionary<ISymbol, List<IMethodSymbol>> DataMemberUsers { get; } = new(Comparer);

    /// <summary>Data class (ClassData/TestCaseSource(typeof)) → test methods.</summary>
    public Dictionary<ISymbol, List<IMethodSymbol>> DataClassUsers { get; } = new(Comparer);

    /// <summary>NUnit TestFixtureSource member → test classes.</summary>
    public Dictionary<ISymbol, List<INamedTypeSymbol>> ClassSourceUsers { get; } = new(Comparer);

    /// <summary>NUnit TestFixtureSource(typeof(T)) → test classes.</summary>
    public Dictionary<ISymbol, List<INamedTypeSymbol>> ClassSourceTypeUsers { get; } = new(Comparer);

    internal void Add<TValue>(Dictionary<ISymbol, List<TValue>> map, ISymbol key, TValue value)
    {
        var normalized = key.OriginalDefinition;
        if (!map.TryGetValue(normalized, out var list))
        {
            map[normalized] = list = new List<TValue>();
        }

        list.Add(value);
    }

    internal static IReadOnlyList<TValue> Get<TValue>(Dictionary<ISymbol, List<TValue>> map, ISymbol key)
    {
        return map.TryGetValue(key.OriginalDefinition, out var list) ? list : Array.Empty<TValue>();
    }
}
