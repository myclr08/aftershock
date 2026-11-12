using System.Collections.Concurrent;
using System.Collections.Immutable;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.FindSymbols;
using Microsoft.CodeAnalysis.Text;

namespace Aftershock.Analyzer.Engine;

[Flags]
public enum ReferenceUsage
{
    Read = 1,
    Write = 2,
    ReadWrite = Read | Write,
}

/// <summary>One reference to a searched symbol, already mapped to the member that contains it.</summary>
/// <param name="Callers">Enclosing members (several for an instance field initializer: every instance constructor).</param>
/// <param name="Document">Document that contains the reference.</param>
/// <param name="Position">Start of the reference.</param>
/// <param name="Usage">Read/write classification (meaningful for properties, indexers and fields).</param>
public sealed record CallerEdge(ImmutableArray<ISymbol> Callers, DocumentId Document, int Position, ReferenceUsage Usage);

/// <summary>
/// Caches <see cref="SymbolFinder.FindReferencesAsync(ISymbol, Solution, CancellationToken)"/> results per symbol,
/// sliced per document so that a long-running host can invalidate only what an edit touched:
/// <see cref="InvalidateDocument"/> drops the document's slice of every entry and marks it stale; the next
/// lookup searches only the stale documents again. Entries whose symbol is declared in the edited document are
/// dropped completely. Symbols stored in entries belong to the solution snapshot they were computed from.
/// </summary>
public sealed class ReferenceCache
{
    private readonly ConcurrentDictionary<string, Entry> _entries = new(StringComparer.Ordinal);
    private int _searches;
    private int _hits;

    public int Searches => _searches;

    public int Hits => _hits;

    public void InvalidateDocument(DocumentId documentId)
    {
        foreach (var (key, entry) in _entries)
        {
            lock (entry.Gate)
            {
                if (entry.DefinitionDocuments.Contains(documentId))
                {
                    _entries.TryRemove(key, out _);
                    continue;
                }

                entry.ByDocument.Remove(documentId);
                entry.Stale.Add(documentId);
            }
        }
    }

    public void Clear() => _entries.Clear();

    public async Task<IReadOnlyList<CallerEdge>> GetReferencesAsync(ISymbol symbol, Solution solution, CancellationToken cancellationToken)
    {
        var key = SymbolKeyOf(symbol, solution);
        var entry = _entries.GetOrAdd(key, _ => new Entry(DefinitionDocumentsOf(symbol, solution)));

        await entry.Lock.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            if (entry.Complete && entry.Stale.Count == 0)
            {
                Interlocked.Increment(ref _hits);
                return entry.Snapshot();
            }

            IImmutableSet<Document>? scope = null;
            if (entry.Complete)
            {
                scope = entry.Stale.Select(solution.GetDocument).OfType<Document>().ToImmutableHashSet();
            }

            Interlocked.Increment(ref _searches);
            var found = await FindAsync(symbol, solution, scope, cancellationToken).ConfigureAwait(false);
            lock (entry.Gate)
            {
                if (scope is not null)
                {
                    foreach (var id in entry.Stale)
                    {
                        entry.ByDocument.Remove(id);
                    }
                }
                else
                {
                    entry.ByDocument.Clear();
                }

                foreach (var group in found.GroupBy(e => e.Document))
                {
                    entry.ByDocument[group.Key] = group.ToList();
                }

                entry.Stale.Clear();
                entry.Complete = true;
                return entry.Snapshot();
            }
        }
        finally
        {
            entry.Lock.Release();
        }
    }

    /// <summary>Project + documentation comment id; stable across snapshots of the same solution.</summary>
    public static string SymbolKeyOf(ISymbol symbol, Solution solution)
    {
        var original = symbol.OriginalDefinition;
        var project = solution.GetProject(original.ContainingAssembly);
        var id = DocumentationCommentId.CreateDeclarationId(original) ?? original.ToDisplayString(SymbolDisplayFormat.FullyQualifiedFormat);
        return (project?.Id.Id.ToString() ?? original.ContainingAssembly?.Name ?? "?") + "|" + id;
    }

    private static HashSet<DocumentId> DefinitionDocumentsOf(ISymbol symbol, Solution solution)
    {
        var result = new HashSet<DocumentId>();
        foreach (var reference in symbol.OriginalDefinition.DeclaringSyntaxReferences)
        {
            var document = solution.GetDocument(reference.SyntaxTree);
            if (document is not null)
            {
                result.Add(document.Id);
            }
        }

        return result;
    }

    private static async Task<List<CallerEdge>> FindAsync(ISymbol symbol, Solution solution, IImmutableSet<Document>? documents, CancellationToken cancellationToken)
    {
        var results = new List<CallerEdge>();
        if (documents is { Count: 0 })
        {
            return results;
        }

        var referenced = await SymbolFinder.FindReferencesAsync(symbol, solution, documents, cancellationToken).ConfigureAwait(false);
        foreach (var group in referenced)
        {
            // FindReferences cascades in both directions of the inheritance hierarchy (base, overrides,
            // implementations). Only references bound to the searched symbol itself are kept; the impact
            // search adds overridden/implemented members explicitly so the direction stays "who can reach me".
            if (!IsSameSymbol(group.Definition, symbol))
            {
                continue;
            }

            foreach (var location in group.Locations)
            {
                if (!location.Location.IsInSource)
                {
                    continue;
                }

                var edge = await MapAsync(location.Document, location.Location.SourceSpan, cancellationToken).ConfigureAwait(false);
                if (edge is not null)
                {
                    results.Add(edge);
                }
            }
        }

        return results;
    }

    private static bool IsSameSymbol(ISymbol definition, ISymbol searched)
    {
        var comparer = SymbolEqualityComparer.Default;
        var d = definition.OriginalDefinition;
        var s = searched.OriginalDefinition;
        if (comparer.Equals(d, s))
        {
            return true;
        }

        return s switch
        {
            IMethodSymbol m => comparer.Equals(d, m.PartialDefinitionPart) || comparer.Equals(d, m.PartialImplementationPart),
            IPropertySymbol p => comparer.Equals(d, p.PartialDefinitionPart) || comparer.Equals(d, p.PartialImplementationPart),
            _ => false,
        };
    }

    private static async Task<CallerEdge?> MapAsync(Document document, TextSpan span, CancellationToken cancellationToken)
    {
        var root = await document.GetSyntaxRootAsync(cancellationToken).ConfigureAwait(false);
        var model = await document.GetSemanticModelAsync(cancellationToken).ConfigureAwait(false);
        if (root is null || model is null)
        {
            return null;
        }

        var callers = EnclosingMembers(root, model, span.Start, cancellationToken);
        if (callers.IsDefaultOrEmpty)
        {
            return null;
        }

        return new CallerEdge(callers, document.Id, span.Start, ClassifyUsage(root, span));
    }

    /// <summary>
    /// Maps a position to the member(s) whose execution runs the code at that position.
    /// Lambdas and local functions map to their enclosing member; instance field/property initializers map to
    /// the instance constructors; references in a type header (attributes, base list) map to the constructors.
    /// </summary>
    public static ImmutableArray<ISymbol> EnclosingMembers(SyntaxNode root, SemanticModel model, int position, CancellationToken cancellationToken)
    {
        var token = root.FindToken(position);
        var context = SyntaxMembers.Classify(token);
        var builder = ImmutableArray.CreateBuilder<ISymbol>();

        void Add(ISymbol? symbol)
        {
            if (symbol is not null)
            {
                builder.Add(symbol);
            }
        }

        INamedTypeSymbol? DeclaredType() =>
            context.Type is { } typeSyntax ? model.GetDeclaredSymbol(typeSyntax, cancellationToken) as INamedTypeSymbol : null;

        switch (context.Kind)
        {
            case ContextKind.Member:
                Add(model.GetDeclaredSymbol(context.Node, cancellationToken));
                break;
            case ContextKind.Accessor:
                var accessor = model.GetDeclaredSymbol(context.Node, cancellationToken) as IMethodSymbol;
                Add(accessor?.MethodKind is MethodKind.EventAdd or MethodKind.EventRemove or MethodKind.EventRaise ? accessor.AssociatedSymbol : accessor);
                break;
            case ContextKind.ExpressionBodyGetter:
                Add((model.GetDeclaredSymbol(context.Node, cancellationToken) as IPropertySymbol)?.GetMethod);
                break;
            case ContextKind.PropertyHeader:
                Add(model.GetDeclaredSymbol(context.Node, cancellationToken));
                break;
            case ContextKind.PropertyInitializer:
                var property = model.GetDeclaredSymbol(context.Node, cancellationToken) as IPropertySymbol;
                if (property is { IsStatic: true })
                {
                    Add(property);
                }
                else
                {
                    builder.AddRange(property?.ContainingType.InstanceConstructors.Cast<ISymbol>() ?? Enumerable.Empty<ISymbol>());
                }

                break;
            case ContextKind.Field:
            case ContextKind.EventField:
                var declaration = context.Node as BaseFieldDeclarationSyntax;
                foreach (var variable in declaration?.Declaration.Variables ?? default)
                {
                    if (variable.FullSpan.Contains(position) || declaration!.Declaration.Variables.Count == 1)
                    {
                        Add(model.GetDeclaredSymbol(variable, cancellationToken));
                    }
                }

                break;
            case ContextKind.FieldInitializer:
            case ContextKind.EventFieldInitializer:
                var member = model.GetDeclaredSymbol(context.Node, cancellationToken);
                if (member is { IsStatic: true })
                {
                    Add(member);
                }
                else if (member is not null)
                {
                    builder.AddRange(member.ContainingType.InstanceConstructors.Cast<ISymbol>());
                }

                break;
            case ContextKind.EnumMember:
                Add(model.GetDeclaredSymbol(context.Node, cancellationToken));
                break;
            case ContextKind.TypeHeader:
            case ContextKind.PrimaryConstructorBase:
                var type = DeclaredType();
                if (type is not null && type.TypeKind is TypeKind.Class or TypeKind.Struct)
                {
                    builder.AddRange(type.InstanceConstructors.Cast<ISymbol>());
                }

                break;
            case ContextKind.GlobalStatement:
                var enclosing = model.GetEnclosingSymbol(position, cancellationToken);
                while (enclosing is IMethodSymbol { MethodKind: MethodKind.AnonymousFunction or MethodKind.LocalFunction or MethodKind.LambdaMethod })
                {
                    enclosing = enclosing.ContainingSymbol;
                }

                Add(enclosing);
                break;
            case ContextKind.FileLevel:
                break;
        }

        return builder.ToImmutable();
    }

    /// <summary>Syntactic read/write classification of a reference (used to split property getter and setter usages).</summary>
    public static ReferenceUsage ClassifyUsage(SyntaxNode root, TextSpan span)
    {
        var node = root.FindNode(span, getInnermostNodeForTie: true);
        SyntaxNode expression = node;
        if (expression is BracketedArgumentListSyntax { Parent: { } elementAccess })
        {
            expression = elementAccess;
        }

        while (expression.Parent is { } parent)
        {
            if (parent is MemberAccessExpressionSyntax memberAccess && memberAccess.Name == expression)
            {
                expression = parent;
            }
            else if (parent is MemberBindingExpressionSyntax binding && binding.Name == expression)
            {
                expression = parent;
            }
            else if (parent is ConditionalAccessExpressionSyntax conditional && conditional.WhenNotNull == expression)
            {
                expression = parent;
            }
            else if (parent is ParenthesizedExpressionSyntax)
            {
                expression = parent;
            }
            else
            {
                break;
            }
        }

        switch (expression.Parent)
        {
            case AssignmentExpressionSyntax assignment when assignment.Left == expression:
                return assignment.IsKind(SyntaxKind.SimpleAssignmentExpression) ? ReferenceUsage.Write : ReferenceUsage.ReadWrite;
            case PrefixUnaryExpressionSyntax prefix when prefix.IsKind(SyntaxKind.PreIncrementExpression) || prefix.IsKind(SyntaxKind.PreDecrementExpression):
                return ReferenceUsage.ReadWrite;
            case PostfixUnaryExpressionSyntax postfix when postfix.IsKind(SyntaxKind.PostIncrementExpression) || postfix.IsKind(SyntaxKind.PostDecrementExpression):
                return ReferenceUsage.ReadWrite;
            case RefExpressionSyntax:
                return ReferenceUsage.ReadWrite;
            case ArgumentSyntax argument:
                if (argument.RefKindKeyword.IsKind(SyntaxKind.OutKeyword))
                {
                    return ReferenceUsage.Write;
                }

                if (argument.RefKindKeyword.IsKind(SyntaxKind.RefKeyword))
                {
                    return ReferenceUsage.ReadWrite;
                }

                if (argument.Parent is TupleExpressionSyntax tuple && IsDeconstructionTarget(tuple))
                {
                    return ReferenceUsage.Write;
                }

                return ReferenceUsage.Read;
            default:
                return ReferenceUsage.Read;
        }
    }

    private static bool IsDeconstructionTarget(TupleExpressionSyntax tuple)
    {
        SyntaxNode current = tuple;
        while (current.Parent is ArgumentSyntax { Parent: TupleExpressionSyntax outer })
        {
            current = outer;
        }

        return current.Parent is AssignmentExpressionSyntax assignment && assignment.Left == current;
    }

    private sealed class Entry
    {
        public Entry(HashSet<DocumentId> definitionDocuments)
        {
            DefinitionDocuments = definitionDocuments;
        }

        public object Gate { get; } = new();

        public SemaphoreSlim Lock { get; } = new(1, 1);

        public HashSet<DocumentId> DefinitionDocuments { get; }

        public Dictionary<DocumentId, List<CallerEdge>> ByDocument { get; } = new();

        public HashSet<DocumentId> Stale { get; } = new();

        public bool Complete { get; set; }

        public IReadOnlyList<CallerEdge> Snapshot()
        {
            lock (Gate)
            {
                return ByDocument.Values.SelectMany(v => v).ToList();
            }
        }
    }
}
