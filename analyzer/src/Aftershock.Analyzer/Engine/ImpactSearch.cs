using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.FindSymbols;

namespace Aftershock.Analyzer.Engine;

/// <summary>A changed symbol that starts the caller search.</summary>
/// <param name="Symbol">The symbol, from the new solution or (when <paramref name="InOld"/>) from the old snapshot fork.</param>
/// <param name="InOld">True for symbols that only exist in the old snapshot (deleted members/files).</param>
public sealed record Seed(ISymbol Symbol, bool InOld);

public sealed record TestHit(INamedTypeSymbol Class, IMethodSymbol Method, IReadOnlyList<string> Chain, string Reason);

public sealed record ProjectFallback(ProjectId Project, string Message);

public sealed class SearchOutcome
{
    public List<TestHit> Tests { get; } = new();

    public List<ProjectFallback> ProjectFallbacks { get; } = new();

    public int Visited { get; set; }

    /// <summary>Set when the search was abandoned (BFS limit); the caller turns it into a fallback.</summary>
    public string? AbortReason { get; set; }
}

/// <summary>Shared state of one analysis: the new solution, the optional old-snapshot fork and their caches.</summary>
public sealed class SearchContext
{
    public SearchContext(Solution newSolution, Solution? oldSolution, ReferenceCache newCache, ReferenceCache oldCache, TestModel tests, ImpactOptions options, AnalysisLog log)
    {
        NewSolution = newSolution;
        OldSolution = oldSolution;
        NewCache = newCache;
        OldCache = oldCache;
        Tests = tests;
        Options = options;
        Log = log;
    }

    public Solution NewSolution { get; }

    public Solution? OldSolution { get; }

    public ReferenceCache NewCache { get; }

    public ReferenceCache OldCache { get; }

    public TestModel Tests { get; }

    public ImpactOptions Options { get; }

    public AnalysisLog Log { get; }
}

/// <summary>
/// Backward breadth-first search from changed symbols to the tests that can reach them.
/// Edges: references (mapped to their enclosing member), overridden/implemented members (so calls through a base
/// class or an interface are found), implicit base constructor calls, and test data sources. The first path that
/// reaches a test is its reason chain, so chains are shortest paths.
/// </summary>
public sealed class ImpactSearch
{
    private enum EdgeKind
    {
        Changed,
        Reference,
        Polymorphic,
        ImplicitBase,
        DataSource,
    }

    private readonly SearchContext _context;
    private readonly Dictionary<string, ISymbol?> _translations = new(StringComparer.Ordinal);
    private readonly SemaphoreSlim _translationLock = new(1, 1);

    public ImpactSearch(SearchContext context)
    {
        _context = context;
    }

    public async Task<SearchOutcome> RunAsync(IReadOnlyList<Seed> seeds, CancellationToken cancellationToken)
    {
        var outcome = new SearchOutcome();
        var visited = new HashSet<string>(StringComparer.Ordinal);
        var counted = 0;
        var frontier = new List<Node>();
        var max = _context.Options.MaxSymbols;

        // Test methods are end points: they are reported, not expanded, and do not count toward the limit
        // (a widely used helper should select its many tests, not fall back).
        bool Counts(ISymbol symbol, bool inOld) => inOld || _context.Tests.GetTestInfo(symbol) is null;

        foreach (var seed in seeds)
        {
            if (visited.Add(Key(seed.Symbol, seed.InOld)))
            {
                frontier.Add(new Node(seed.Symbol, seed.InOld, null, EdgeKind.Changed));
                counted += Counts(seed.Symbol, seed.InOld) ? 1 : 0;
            }
        }

        if (max > 0 && counted > max)
        {
            outcome.Visited = visited.Count;
            outcome.AbortReason = $"BFS limit exceeded: {counted} changed symbols (limit {max})";
            return outcome;
        }

        while (frontier.Count > 0)
        {
            cancellationToken.ThrowIfCancellationRequested();
            foreach (var node in frontier)
            {
                await VisitAsync(node, outcome, cancellationToken).ConfigureAwait(false);
            }

            var current = frontier.Where(n => Counts(n.Symbol, n.InOld)).ToList();
            var expansions = new List<(ISymbol Symbol, bool InOld, EdgeKind Kind)>[current.Count];
            await Parallel.ForEachAsync(
                Enumerable.Range(0, current.Count),
                new ParallelOptions { MaxDegreeOfParallelism = _context.Options.MaxParallelism, CancellationToken = cancellationToken },
                async (i, token) => expansions[i] = await ExpandAsync(current[i], token).ConfigureAwait(false)).ConfigureAwait(false);

            var next = new List<Node>();
            for (var i = 0; i < current.Count; i++)
            {
                foreach (var (symbol, inOld, kind) in expansions[i])
                {
                    if (!visited.Add(Key(symbol, inOld)))
                    {
                        continue;
                    }

                    if (Counts(symbol, inOld) && max > 0 && ++counted > max)
                    {
                        outcome.Visited = visited.Count;
                        outcome.AbortReason = $"BFS limit exceeded: more than {max} symbols (test methods not counted) reachable from the change";
                        return outcome;
                    }

                    next.Add(new Node(symbol, inOld, current[i], kind));
                }
            }

            frontier = next;
        }

        outcome.Visited = visited.Count;
        return outcome;
    }

    private async Task VisitAsync(Node node, SearchOutcome outcome, CancellationToken cancellationToken)
    {
        if (node.InOld)
        {
            return;
        }

        var tests = _context.Tests;
        var symbol = node.Symbol;

        if (tests.GetTestInfo(symbol) is not null && symbol is IMethodSymbol method)
        {
            var reason = node.Parent is null ? "changedTest" : node.Kind == EdgeKind.DataSource ? "dataSource" : "referenceChain";
            foreach (var testClass in await tests.GetRunnableClassesAsync(method.ContainingType, cancellationToken).ConfigureAwait(false))
            {
                if (!tests.GetTestMethods(testClass).Contains(method.OriginalDefinition, SymbolEqualityComparer.Default))
                {
                    continue;
                }

                var chain = node.Chain();
                chain[^1] = SymbolNames.Short(testClass) + "." + method.Name;
                outcome.Tests.Add(new TestHit(testClass, (IMethodSymbol)method.OriginalDefinition, chain, reason));
            }
        }

        if (symbol.ContainingType is not { } type)
        {
            return;
        }

        if (TestModel.IsAssemblyLifecycle(symbol) && _context.NewSolution.GetProject(symbol.ContainingAssembly) is { } setupProject)
        {
            outcome.ProjectFallbacks.Add(new ProjectFallback(setupProject.Id, $"assembly-level test setup reached: {string.Join(" ← ", node.Chain())}"));
        }

        var indexes = await tests.GetIndexesAsync().ConfigureAwait(false);
        if (TestModel.IsClassLifecycle(symbol))
        {
            await AddWholeClassAsync(type, node, "classLifecycle", outcome, cancellationToken).ConfigureAwait(false);

            foreach (var user in TestIndexes.Get(indexes.FixtureUsers, type))
            {
                await AddWholeClassAsync(user, node, "fixture", outcome, cancellationToken).ConfigureAwait(false);
            }

            foreach (var projectId in TestIndexes.Get(indexes.AssemblyFixtures, type))
            {
                outcome.ProjectFallbacks.Add(new ProjectFallback(projectId, $"assembly fixture reached: {string.Join(" ← ", node.Chain())}"));
            }
        }

        var dataKey = symbol is IMethodSymbol { AssociatedSymbol: { } associated } ? associated : symbol;
        foreach (var user in TestIndexes.Get(indexes.ClassSourceUsers, dataKey))
        {
            await AddWholeClassAsync(user, node, "dataSource", outcome, cancellationToken).ConfigureAwait(false);
        }

        foreach (var user in TestIndexes.Get(indexes.ClassSourceTypeUsers, type))
        {
            await AddWholeClassAsync(user, node, "dataSource", outcome, cancellationToken).ConfigureAwait(false);
        }
    }

    private async Task AddWholeClassAsync(INamedTypeSymbol type, Node node, string reason, SearchOutcome outcome, CancellationToken cancellationToken)
    {
        var tests = _context.Tests;
        foreach (var testClass in await tests.GetRunnableClassesAsync(type, cancellationToken).ConfigureAwait(false))
        {
            foreach (var testMethod in tests.GetTestMethods(testClass))
            {
                var chain = node.Chain();
                chain.Add(SymbolNames.Short(testClass) + "." + testMethod.Name);
                outcome.Tests.Add(new TestHit(testClass, testMethod, chain, reason));
            }
        }
    }

    private async Task<List<(ISymbol Symbol, bool InOld, EdgeKind Kind)>> ExpandAsync(Node node, CancellationToken cancellationToken)
    {
        var solution = node.InOld ? _context.OldSolution! : _context.NewSolution;
        var cache = node.InOld ? _context.OldCache : _context.NewCache;
        var symbol = node.Symbol;
        var result = new List<(ISymbol Symbol, bool InOld, EdgeKind Kind)>();

        // Calls through a base class or an interface reach this member at run time.
        ISymbol? overridden = symbol switch
        {
            IMethodSymbol m => m.OverriddenMethod,
            IPropertySymbol p => p.OverriddenProperty,
            IEventSymbol e => e.OverriddenEvent,
            _ => null,
        };
        // Members declared outside the solution (object.ToString, IDisposable.Dispose, ...) are not followed:
        // their callers are mostly framework code and their fan-out would swamp the search.
        if (overridden is not null && IsInSource(overridden))
        {
            result.Add((overridden.OriginalDefinition, node.InOld, EdgeKind.Polymorphic));
        }

        if (symbol is IMethodSymbol { MethodKind: MethodKind.Ordinary or MethodKind.PropertyGet or MethodKind.PropertySet or MethodKind.ExplicitInterfaceImplementation or MethodKind.EventAdd or MethodKind.EventRemove } or IPropertySymbol or IEventSymbol
            && !symbol.IsStatic)
        {
            var implemented = await SymbolFinder.FindImplementedInterfaceMembersAsync(symbol, solution, cancellationToken: cancellationToken).ConfigureAwait(false);
            foreach (var member in implemented.Where(IsInSource))
            {
                result.Add((member.OriginalDefinition, node.InOld, EdgeKind.Polymorphic));
            }
        }

        // References, mapped to their enclosing members. Accessors search the property and keep reads or writes.
        var (search, usage) = symbol switch
        {
            IMethodSymbol { MethodKind: MethodKind.PropertyGet, AssociatedSymbol: IPropertySymbol property } => ((ISymbol)property, (ReferenceUsage?)ReferenceUsage.Read),
            IMethodSymbol { MethodKind: MethodKind.PropertySet, AssociatedSymbol: IPropertySymbol property } => (property, ReferenceUsage.Write),
            _ => (symbol, null),
        };

        var edges = await cache.GetReferencesAsync(search, solution, cancellationToken).ConfigureAwait(false);
        foreach (var edge in edges
                     .OrderBy(e => solution.GetDocument(e.Document)?.FilePath ?? string.Empty, StringComparer.Ordinal)
                     .ThenBy(e => e.Position))
        {
            if (usage is { } filter && (edge.Usage & filter) == 0)
            {
                continue;
            }

            foreach (var caller in edge.Callers)
            {
                result.Add((caller.OriginalDefinition, node.InOld, EdgeKind.Reference));
            }
        }

        // Derived constructors without an explicit initializer call a parameterless base constructor implicitly;
        // FindReferences does not report those calls.
        if (symbol is IMethodSymbol { MethodKind: MethodKind.Constructor, IsStatic: false } constructor
            && constructor.Parameters.All(p => p.IsOptional || p.IsParams)
            && constructor.ContainingType is { TypeKind: TypeKind.Class, IsSealed: false, IsStatic: false } baseType)
        {
            var derived = await SymbolFinder.FindDerivedClassesAsync(baseType, solution, transitive: false, cancellationToken: cancellationToken).ConfigureAwait(false);
            foreach (var derivedType in derived.OrderBy(t => t.ToDisplayString(), StringComparer.Ordinal))
            {
                foreach (var derivedConstructor in derivedType.InstanceConstructors)
                {
                    if (HasImplicitBaseCall(derivedConstructor))
                    {
                        result.Add((derivedConstructor.OriginalDefinition, node.InOld, EdgeKind.ImplicitBase));
                    }
                }
            }
        }

        // A static constructor runs before the first use of any static member and before construction.
        if (symbol is IMethodSymbol { MethodKind: MethodKind.StaticConstructor, ContainingType: { } staticOwner })
        {
            foreach (var member in staticOwner.GetMembers())
            {
                if (member is IMethodSymbol { MethodKind: MethodKind.Constructor }
                    || (member.IsStatic && member is IMethodSymbol { MethodKind: MethodKind.Ordinary } or IPropertySymbol or IFieldSymbol { IsImplicitlyDeclared: false } or IEventSymbol))
                {
                    result.Add((member.OriginalDefinition, node.InOld, EdgeKind.Reference));
                }
            }
        }

        // Test data sources referenced by name (MemberData("X"), TestCaseSource("X"), DynamicData("X")) or by type (ClassData).
        if (!node.InOld)
        {
            var indexes = await _context.Tests.GetIndexesAsync().ConfigureAwait(false);
            var dataKey = symbol is IMethodSymbol { AssociatedSymbol: { } associated } ? associated : symbol;
            foreach (var test in TestIndexes.Get(indexes.DataMemberUsers, dataKey))
            {
                result.Add((test, false, EdgeKind.DataSource));
            }

            if (symbol.ContainingType is { } containingType)
            {
                foreach (var test in TestIndexes.Get(indexes.DataClassUsers, containingType))
                {
                    result.Add((test, false, EdgeKind.DataSource));
                }
            }
        }

        if (!node.InOld)
        {
            return result;
        }

        // Continue in the new solution as soon as a symbol of the old snapshot still exists there.
        var translated = new List<(ISymbol Symbol, bool InOld, EdgeKind Kind)>(result.Count);
        foreach (var (oldSymbol, _, kind) in result)
        {
            var newSymbol = await TranslateAsync(oldSymbol, cancellationToken).ConfigureAwait(false);
            translated.Add(newSymbol is null ? (oldSymbol, true, kind) : (newSymbol, false, kind));
        }

        return translated;
    }

    private async Task<ISymbol?> TranslateAsync(ISymbol oldSymbol, CancellationToken cancellationToken)
    {
        var oldSolution = _context.OldSolution!;
        var key = ReferenceCache.SymbolKeyOf(oldSymbol, oldSolution);
        await _translationLock.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            if (_translations.TryGetValue(key, out var cached))
            {
                return cached;
            }

            ISymbol? resolved = null;
            var id = DocumentationCommentId.CreateDeclarationId(oldSymbol.OriginalDefinition);
            var oldProject = oldSolution.GetProject(oldSymbol.ContainingAssembly, cancellationToken);
            var newProject = oldProject is null ? null : _context.NewSolution.GetProject(oldProject.Id);
            if (id is not null && newProject is not null)
            {
                var compilation = await newProject.GetCompilationAsync(cancellationToken).ConfigureAwait(false);
                if (compilation is not null)
                {
                    resolved = DocumentationCommentId.GetSymbolsForDeclarationId(id, compilation)
                        .FirstOrDefault(s => SymbolEqualityComparer.Default.Equals(s.ContainingAssembly, compilation.Assembly));
                }
            }

            _translations[key] = resolved;
            return resolved;
        }
        finally
        {
            _translationLock.Release();
        }
    }

    private static bool IsInSource(ISymbol symbol) => symbol.Locations.Any(l => l.IsInSource);

    private static bool HasImplicitBaseCall(IMethodSymbol constructor)
    {
        if (constructor.IsImplicitlyDeclared)
        {
            return true;
        }

        foreach (var reference in constructor.DeclaringSyntaxReferences)
        {
            switch (reference.GetSyntax())
            {
                case ConstructorDeclarationSyntax declaration:
                    return declaration.Initializer is null;
                case TypeDeclarationSyntax primary:
                    return primary.BaseList?.Types.FirstOrDefault() is not PrimaryConstructorBaseTypeSyntax;
            }
        }

        return false;
    }

    private string Key(ISymbol symbol, bool inOld)
    {
        var solution = inOld ? _context.OldSolution! : _context.NewSolution;
        return (inOld ? "old|" : "new|") + ReferenceCache.SymbolKeyOf(symbol, solution);
    }

    private sealed class Node
    {
        public Node(ISymbol symbol, bool inOld, Node? parent, EdgeKind kind)
        {
            Symbol = symbol;
            InOld = inOld;
            Parent = parent;
            Kind = kind;
        }

        public ISymbol Symbol { get; }

        public bool InOld { get; }

        public Node? Parent { get; }

        public EdgeKind Kind { get; }

        /// <summary>Labels from the changed symbol to this node.</summary>
        public List<string> Chain()
        {
            var labels = new List<string>();
            for (var n = this; n is not null; n = n.Parent)
            {
                labels.Add(SymbolNames.Short(n.Symbol) + (n.InOld ? " (removed)" : string.Empty));
            }

            labels.Reverse();
            return labels;
        }
    }
}
