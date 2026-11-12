using System.Text;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace Aftershock.Analyzer.Engine;

/// <summary>Where a position sits, syntactically, relative to members and types.</summary>
public enum ContextKind
{
    /// <summary>Inside a method, constructor, destructor, operator, conversion or an event with accessors.</summary>
    Member,

    /// <summary>Inside a property/indexer/event accessor.</summary>
    Accessor,

    /// <summary>Inside the expression body of a property/indexer (an implicit getter).</summary>
    ExpressionBodyGetter,

    /// <summary>Property/indexer declaration outside accessors and initializer (attributes, type, name, parameters).</summary>
    PropertyHeader,

    /// <summary>Property initializer (<c>= value;</c>).</summary>
    PropertyInitializer,

    /// <summary>Field declaration outside the initializer.</summary>
    Field,

    /// <summary>Field initializer.</summary>
    FieldInitializer,

    /// <summary>Field-like event declaration.</summary>
    EventField,

    /// <summary>Field-like event initializer.</summary>
    EventFieldInitializer,

    EnumMember,

    /// <summary>Type declaration outside members: attributes, modifiers, base list, parameter list, braces.</summary>
    TypeHeader,

    /// <summary>Arguments of a primary constructor base call (<c>class C(int x) : Base(x)</c>).</summary>
    PrimaryConstructorBase,

    /// <summary>Top-level statement.</summary>
    GlobalStatement,

    /// <summary>Outside any type: usings, namespace declarations, assembly attributes.</summary>
    FileLevel,
}

public sealed record SyntaxContext(ContextKind Kind, SyntaxNode Node)
{
    /// <summary>The declaring type syntax, when inside a type.</summary>
    public MemberDeclarationSyntax? Type => Node.AncestorsAndSelf().FirstOrDefault(IsTypeDeclaration) as MemberDeclarationSyntax;

    internal static bool IsTypeDeclaration(SyntaxNode n) => n is BaseTypeDeclarationSyntax or DelegateDeclarationSyntax;
}

public static class SyntaxMembers
{
    /// <summary>Classifies a token by walking up to the innermost member-like declaration.</summary>
    public static SyntaxContext Classify(SyntaxToken token)
    {
        var start = token.Parent;
        if (start is null)
        {
            return new SyntaxContext(ContextKind.FileLevel, token.SyntaxTree!.GetRoot());
        }

        foreach (var node in start.AncestorsAndSelf())
        {
            switch (node)
            {
                case AccessorDeclarationSyntax accessor:
                    return new SyntaxContext(ContextKind.Accessor, accessor);
                case ArrowExpressionClauseSyntax arrow when arrow.Parent is PropertyDeclarationSyntax or IndexerDeclarationSyntax:
                    return new SyntaxContext(ContextKind.ExpressionBodyGetter, arrow.Parent);
                case BaseMethodDeclarationSyntax method:
                    return new SyntaxContext(ContextKind.Member, method);
                case EqualsValueClauseSyntax { Parent: PropertyDeclarationSyntax property }:
                    return new SyntaxContext(ContextKind.PropertyInitializer, property);
                case EqualsValueClauseSyntax { Parent: VariableDeclaratorSyntax { Parent.Parent: FieldDeclarationSyntax } declarator }:
                    return new SyntaxContext(ContextKind.FieldInitializer, declarator);
                case EqualsValueClauseSyntax { Parent: VariableDeclaratorSyntax { Parent.Parent: EventFieldDeclarationSyntax } declarator }:
                    return new SyntaxContext(ContextKind.EventFieldInitializer, declarator);
                case PropertyDeclarationSyntax or IndexerDeclarationSyntax:
                    return new SyntaxContext(ContextKind.PropertyHeader, node);
                case EventDeclarationSyntax eventDeclaration:
                    return new SyntaxContext(ContextKind.Member, eventDeclaration);
                case FieldDeclarationSyntax field:
                    return new SyntaxContext(ContextKind.Field, field);
                case EventFieldDeclarationSyntax eventField:
                    return new SyntaxContext(ContextKind.EventField, eventField);
                case EnumMemberDeclarationSyntax enumMember:
                    return new SyntaxContext(ContextKind.EnumMember, enumMember);
                case PrimaryConstructorBaseTypeSyntax primaryBase when primaryBase.Parent?.Parent is TypeDeclarationSyntax:
                    return new SyntaxContext(ContextKind.PrimaryConstructorBase, primaryBase.Parent.Parent);
                case BaseTypeDeclarationSyntax or DelegateDeclarationSyntax:
                    return new SyntaxContext(ContextKind.TypeHeader, node);
                case GlobalStatementSyntax global:
                    return new SyntaxContext(ContextKind.GlobalStatement, global.Parent ?? global);
                case BaseNamespaceDeclarationSyntax or CompilationUnitSyntax:
                    return new SyntaxContext(ContextKind.FileLevel, node);
            }
        }

        return new SyntaxContext(ContextKind.FileLevel, start.SyntaxTree.GetRoot());
    }

    /// <summary>All type declarations in a tree (nested included), outermost first.</summary>
    public static IEnumerable<MemberDeclarationSyntax> TypeDeclarations(SyntaxNode root)
    {
        return root.DescendantNodes(n => n is CompilationUnitSyntax or BaseNamespaceDeclarationSyntax or TypeDeclarationSyntax)
            .Where(SyntaxContext.IsTypeDeclaration)
            .Cast<MemberDeclarationSyntax>();
    }

    /// <summary>Stable syntactic key of a type: namespace + nesting chain + arity, e.g. <c>Ns.Outer`1+Inner</c>.</summary>
    public static string TypeKey(SyntaxNode typeDeclaration)
    {
        var parts = new List<string>();
        foreach (var node in typeDeclaration.AncestorsAndSelf())
        {
            switch (node)
            {
                case TypeDeclarationSyntax type:
                    parts.Add(type.Identifier.ValueText + Arity(type.TypeParameterList));
                    break;
                case EnumDeclarationSyntax enumDeclaration:
                    parts.Add(enumDeclaration.Identifier.ValueText);
                    break;
                case DelegateDeclarationSyntax delegateDeclaration:
                    parts.Add(delegateDeclaration.Identifier.ValueText + Arity(delegateDeclaration.TypeParameterList));
                    break;
            }
        }

        parts.Reverse();
        var ns = string.Join(".", typeDeclaration.Ancestors().OfType<BaseNamespaceDeclarationSyntax>().Reverse().Select(n => Normalize(n.Name.ToString())));
        return (ns.Length > 0 ? ns + "." : string.Empty) + string.Join("+", parts);
    }

    /// <summary>
    /// Syntactic key of a member-like context used to pair the old and new version of a member in the same file.
    /// Returns null for contexts that are not members (type headers, file level).
    /// </summary>
    public static string? MemberKey(SyntaxContext context)
    {
        var type = context.Type;
        var typeKey = type is null ? "<global>" : TypeKey(type);
        string? local = context.Kind switch
        {
            ContextKind.Member or ContextKind.PropertyHeader or ContextKind.PropertyInitializer => MemberLocalKey(context.Node),
            ContextKind.Accessor => AccessorKey((AccessorDeclarationSyntax)context.Node),
            ContextKind.ExpressionBodyGetter => MemberLocalKey(context.Node) + "/get",
            ContextKind.FieldInitializer or ContextKind.EventFieldInitializer => "F:" + ((VariableDeclaratorSyntax)context.Node).Identifier.ValueText,
            ContextKind.EventField => "E:" + string.Join(",", ((EventFieldDeclarationSyntax)context.Node).Declaration.Variables.Select(v => v.Identifier.ValueText)),
            ContextKind.EnumMember => "F:" + ((EnumMemberDeclarationSyntax)context.Node).Identifier.ValueText,
            ContextKind.GlobalStatement => "<top-level>",
            _ => null,
        };

        return local is null ? null : typeKey + "::" + local;
    }

    /// <summary>Key of the property/indexer/event that owns an accessor key, or null when the key is not an accessor key.</summary>
    public static string? OwnerOfAccessorKey(string key)
    {
        var slash = key.LastIndexOf('/');
        return slash > key.LastIndexOf(')') && slash > key.LastIndexOf("::", StringComparison.Ordinal) ? key[..slash] : null;
    }

    /// <summary>Indexes every member-like declaration of a tree by <see cref="MemberKey"/>.</summary>
    public static Dictionary<string, SyntaxContext> IndexMembers(SyntaxNode root)
    {
        var index = new Dictionary<string, SyntaxContext>(StringComparer.Ordinal);
        foreach (var node in root.DescendantNodes())
        {
            SyntaxContext? context = node switch
            {
                BaseMethodDeclarationSyntax or EventDeclarationSyntax => new SyntaxContext(ContextKind.Member, node),
                PropertyDeclarationSyntax or IndexerDeclarationSyntax => new SyntaxContext(ContextKind.PropertyHeader, node),
                AccessorDeclarationSyntax => new SyntaxContext(ContextKind.Accessor, node),
                ArrowExpressionClauseSyntax { Parent: PropertyDeclarationSyntax or IndexerDeclarationSyntax } arrow => new SyntaxContext(ContextKind.ExpressionBodyGetter, arrow.Parent!),
                EventFieldDeclarationSyntax => new SyntaxContext(ContextKind.EventField, node),
                EnumMemberDeclarationSyntax => new SyntaxContext(ContextKind.EnumMember, node),
                GlobalStatementSyntax when node.Parent is CompilationUnitSyntax => new SyntaxContext(ContextKind.GlobalStatement, node.Parent),
                _ => null,
            };

            if (context is null)
            {
                continue;
            }

            var key = MemberKey(context);
            if (key is not null)
            {
                index.TryAdd(key, context);
            }
        }

        return index;
    }

    /// <summary>The syntax compared to decide whether a member really changed (trivia is ignored).</summary>
    public static SyntaxNode ComparisonNode(SyntaxContext context)
    {
        return context.Kind switch
        {
            ContextKind.ExpressionBodyGetter => ((BasePropertyDeclarationSyntax)context.Node) switch
            {
                PropertyDeclarationSyntax p => (SyntaxNode?)p.ExpressionBody ?? p,
                IndexerDeclarationSyntax i => (SyntaxNode?)i.ExpressionBody ?? i,
                var other => other,
            },
            ContextKind.GlobalStatement => context.Node,
            _ => context.Node,
        };
    }

    /// <summary>
    /// Compares the part of a member a changed line belongs to: a property header (attributes, modifiers, type,
    /// name), a property initializer, or the whole member/accessor/expression body otherwise.
    /// </summary>
    public static bool PartEquivalent(SyntaxContext oldContext, SyntaxContext newContext, ContextKind part)
    {
        if (oldContext.Node is BasePropertyDeclarationSyntax oldProperty && newContext.Node is BasePropertyDeclarationSyntax newProperty)
        {
            switch (part)
            {
                case ContextKind.PropertyHeader:
                    return PropertyHeaderEquivalent(oldProperty, newProperty);
                case ContextKind.PropertyInitializer:
                    return NodeEquivalent((oldProperty as PropertyDeclarationSyntax)?.Initializer, (newProperty as PropertyDeclarationSyntax)?.Initializer);
            }
        }

        return AreEquivalent(oldContext, newContext);
    }

    private static bool PropertyHeaderEquivalent(BasePropertyDeclarationSyntax a, BasePropertyDeclarationSyntax b)
    {
        if (a.Kind() != b.Kind()
            || !NodeListEquivalent(a.AttributeLists, b.AttributeLists)
            || !a.Modifiers.Select(m => m.ValueText).SequenceEqual(b.Modifiers.Select(m => m.ValueText))
            || !NodeEquivalent(a.Type, b.Type)
            || !NodeEquivalent(a.ExplicitInterfaceSpecifier, b.ExplicitInterfaceSpecifier))
        {
            return false;
        }

        return (a, b) switch
        {
            (PropertyDeclarationSyntax p, PropertyDeclarationSyntax q) => p.Identifier.ValueText == q.Identifier.ValueText
                && (p.ExpressionBody is null) == (q.ExpressionBody is null)
                && (p.AccessorList is null) == (q.AccessorList is null),
            (IndexerDeclarationSyntax p, IndexerDeclarationSyntax q) => NodeEquivalent(p.ParameterList, q.ParameterList)
                && (p.ExpressionBody is null) == (q.ExpressionBody is null),
            (EventDeclarationSyntax p, EventDeclarationSyntax q) => p.Identifier.ValueText == q.Identifier.ValueText,
            _ => true,
        };
    }

    public static bool AreEquivalent(SyntaxContext oldContext, SyntaxContext newContext)
    {
        if (oldContext.Kind == ContextKind.GlobalStatement && newContext.Kind == ContextKind.GlobalStatement)
        {
            var oldStatements = oldContext.Node.ChildNodes().OfType<GlobalStatementSyntax>().ToList();
            var newStatements = newContext.Node.ChildNodes().OfType<GlobalStatementSyntax>().ToList();
            return oldStatements.Count == newStatements.Count
                && oldStatements.Zip(newStatements).All(pair => SyntaxFactory.AreEquivalent(pair.First, pair.Second, topLevel: false));
        }

        return SyntaxFactory.AreEquivalent(ComparisonNode(oldContext), ComparisonNode(newContext), topLevel: false);
    }

    /// <summary>
    /// Everything about a type declaration that is not inside a non-field member: header, fields and the member list.
    /// Two declarations with equal shapes differ only inside method/property/event bodies.
    /// </summary>
    public static bool TypeShapesEqual(MemberDeclarationSyntax oldType, MemberDeclarationSyntax newType)
    {
        if (oldType.Kind() != newType.Kind())
        {
            return false;
        }

        if (oldType is DelegateDeclarationSyntax || newType is DelegateDeclarationSyntax)
        {
            return SyntaxFactory.AreEquivalent(oldType, newType, topLevel: false);
        }

        if (!NodeListEquivalent(oldType.AttributeLists, newType.AttributeLists)
            || !oldType.Modifiers.Select(m => m.ValueText).SequenceEqual(newType.Modifiers.Select(m => m.ValueText)))
        {
            return false;
        }

        switch (oldType, newType)
        {
            case (TypeDeclarationSyntax o, TypeDeclarationSyntax n):
                if (!NodeEquivalent(o.TypeParameterList, n.TypeParameterList)
                    || !NodeEquivalent(o.ParameterList, n.ParameterList)
                    || !NodeEquivalent(o.BaseList, n.BaseList)
                    || !NodeListEquivalent(o.ConstraintClauses, n.ConstraintClauses))
                {
                    return false;
                }

                var oldFields = o.Members.OfType<BaseFieldDeclarationSyntax>().ToList();
                var newFields = n.Members.OfType<BaseFieldDeclarationSyntax>().ToList();
                if (!NodeListEquivalent(oldFields, newFields))
                {
                    return false;
                }

                return MemberKeySet(o).SetEquals(MemberKeySet(n));
            case (EnumDeclarationSyntax o, EnumDeclarationSyntax n):
                return NodeEquivalent(o.BaseList, n.BaseList)
                    && o.Members.Select(m => m.Identifier.ValueText).SequenceEqual(n.Members.Select(m => m.Identifier.ValueText));
            default:
                return SyntaxFactory.AreEquivalent(oldType, newType, topLevel: false);
        }
    }

    /// <summary>File-level shape: usings, extern aliases, assembly attributes and namespace names.</summary>
    public static bool FileShapesEqual(SyntaxNode oldRoot, SyntaxNode newRoot)
    {
        static IEnumerable<SyntaxNode> Shape(SyntaxNode root) =>
            root.DescendantNodes(n => n is CompilationUnitSyntax or BaseNamespaceDeclarationSyntax)
                .Where(n => n is UsingDirectiveSyntax or ExternAliasDirectiveSyntax or AttributeListSyntax { Parent: CompilationUnitSyntax })
                .Concat(root.DescendantNodes(n => n is CompilationUnitSyntax or BaseNamespaceDeclarationSyntax)
                    .OfType<BaseNamespaceDeclarationSyntax>()
                    .Select(n => (SyntaxNode)n.Name));

        return NodeListEquivalent(Shape(oldRoot).ToList(), Shape(newRoot).ToList());
    }

    /// <summary>Keys of the non-field, non-type members declared in one type declaration.</summary>
    public static HashSet<string> MemberKeySet(TypeDeclarationSyntax type)
    {
        var keys = new HashSet<string>(StringComparer.Ordinal);
        foreach (var member in type.Members)
        {
            if (member is BaseFieldDeclarationSyntax and not EventFieldDeclarationSyntax || SyntaxContext.IsTypeDeclaration(member))
            {
                continue;
            }

            var context = member switch
            {
                PropertyDeclarationSyntax or IndexerDeclarationSyntax => new SyntaxContext(ContextKind.PropertyHeader, member),
                EventFieldDeclarationSyntax => new SyntaxContext(ContextKind.EventField, member),
                _ => new SyntaxContext(ContextKind.Member, member),
            };

            var key = MemberKey(context);
            if (key is not null)
            {
                keys.Add(key);
            }
        }

        return keys;
    }

    private static bool NodeEquivalent(SyntaxNode? a, SyntaxNode? b)
    {
        if (a is null || b is null)
        {
            return a is null && b is null;
        }

        return SyntaxFactory.AreEquivalent(a, b, topLevel: false);
    }

    private static bool NodeListEquivalent<T>(IReadOnlyList<T> a, IReadOnlyList<T> b)
        where T : SyntaxNode
    {
        if (a.Count != b.Count)
        {
            return false;
        }

        for (var i = 0; i < a.Count; i++)
        {
            if (!SyntaxFactory.AreEquivalent(a[i], b[i], topLevel: false))
            {
                return false;
            }
        }

        return true;
    }

    private static bool NodeListEquivalent<T>(SyntaxList<T> a, SyntaxList<T> b)
        where T : SyntaxNode => NodeListEquivalent((IReadOnlyList<T>)a, b);

    private static bool NodeListEquivalent<T>(SeparatedSyntaxList<T> a, SeparatedSyntaxList<T> b)
        where T : SyntaxNode => NodeListEquivalent((IReadOnlyList<T>)a, b);

    private static string AccessorKey(AccessorDeclarationSyntax accessor)
    {
        var owner = accessor.Parent?.Parent;
        return (owner is null ? "?" : MemberLocalKey(owner)) + "/" + accessor.Keyword.ValueText;
    }

    private static string MemberLocalKey(SyntaxNode member)
    {
        return member switch
        {
            MethodDeclarationSyntax m => "M:" + ExplicitInterface(m.ExplicitInterfaceSpecifier) + m.Identifier.ValueText + Arity(m.TypeParameterList) + Parameters(m.ParameterList),
            ConstructorDeclarationSyntax c => (c.Modifiers.Any(SyntaxKind.StaticKeyword) ? "C:static" : "C:") + Parameters(c.ParameterList),
            DestructorDeclarationSyntax => "D:~",
            OperatorDeclarationSyntax o => "O:" + ExplicitInterface(o.ExplicitInterfaceSpecifier) + o.OperatorToken.ValueText + Parameters(o.ParameterList),
            ConversionOperatorDeclarationSyntax c => "V:" + c.ImplicitOrExplicitKeyword.ValueText + Parameters(c.ParameterList) + "->" + Normalize(c.Type.ToString()),
            PropertyDeclarationSyntax p => "P:" + ExplicitInterface(p.ExplicitInterfaceSpecifier) + p.Identifier.ValueText,
            IndexerDeclarationSyntax i => "I:" + ExplicitInterface(i.ExplicitInterfaceSpecifier) + Parameters(i.ParameterList),
            EventDeclarationSyntax e => "E:" + ExplicitInterface(e.ExplicitInterfaceSpecifier) + e.Identifier.ValueText,
            EventFieldDeclarationSyntax ef => "E:" + string.Join(",", ef.Declaration.Variables.Select(v => v.Identifier.ValueText)),
            _ => member.Kind().ToString(),
        };
    }

    private static string ExplicitInterface(ExplicitInterfaceSpecifierSyntax? specifier)
    {
        return specifier is null ? string.Empty : Normalize(specifier.Name.ToString()) + ".";
    }

    private static string Arity(TypeParameterListSyntax? list)
    {
        return list is null || list.Parameters.Count == 0 ? string.Empty : "`" + list.Parameters.Count;
    }

    private static string Parameters(BaseParameterListSyntax? list)
    {
        if (list is null)
        {
            return "()";
        }

        var sb = new StringBuilder("(");
        var first = true;
        foreach (var parameter in list.Parameters)
        {
            if (!first)
            {
                sb.Append(',');
            }

            first = false;
            foreach (var modifier in parameter.Modifiers)
            {
                sb.Append(modifier.ValueText).Append(' ');
            }

            sb.Append(Normalize(parameter.Type?.ToString() ?? "?"));
        }

        return sb.Append(')').ToString();
    }

    private static string Normalize(string text)
    {
        var sb = new StringBuilder(text.Length);
        foreach (var c in text)
        {
            if (!char.IsWhiteSpace(c))
            {
                sb.Append(c);
            }
        }

        return sb.ToString();
    }
}
