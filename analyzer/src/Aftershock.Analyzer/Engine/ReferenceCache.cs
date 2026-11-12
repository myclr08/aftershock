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
/// sliced per document, so that a long-running host can invalidate only what an edit touched.
/// <para>
/// Entries are independent of the solution snapshot they were computed in: a slice stores only the positions of the
/// references (bound to the searched symbol) in one document. Every lookup maps those positions to their enclosing
/// members again, on the semantic model of the solution passed in, so the returned symbols always belong to the
/// current compilation (symbols of an older snapshot would not be found by later lookups and would keep old
/// compilations alive). The key of an entry is the project id plus the documentation comment id of the symbol.
/// </para>
/// <para>
/// Invalidation rules (a cache must never hide a reference):
/// <list type="bullet">
/// <item><see cref="InvalidateDocumentReferences"/>: the document's text changed but its declarations did not (a body
/// edit). Binding in other documents cannot change, so only the document's own slice of every entry is re-searched on
/// the next lookup.</item>
/// <item><see cref="InvalidateDocument"/>: additionally drops entries whose symbol is declared in the document.</item>
/// <item><see cref="InvalidateProjects"/>: a declaration-level change (a member, type, signature or document added,
/// removed or changed) can change what any document of the project, or of a project depending on it, binds to.
/// Entries of symbols declared in those projects are dropped; every other entry re-searches all their documents.</item>
/// </list>
/// </para>
/// </summary>
public sealed class ReferenceCache
{
    private readonly ConcurrentDictionary<string, Entry> _entries = new(StringComparer.Ordinal);
    private int _searches;
    private int _scopedSearches;
    private int _hits;

    /// <summary>Number of full reference searches (whole solution), cumulative.</summary>
    public int Searches => _searches;

    /// <summary>Number of searches limited to the documents invalidated since the entry was cached, cumulative.</summary>
    public int ScopedSearches => _scopedSearches;

    /// <summary>Number of lookups answered without any search, cumulative.</summary>
    public int Hits => _hits;

    /// <summary>Number of cached symbols.</summary>
    public int Count => _entries.Count;

    /// <summary>The document's text changed: drop entries of symbols declared in it and re-search its slice of the others.</summary>
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

    /// <summary>
    /// The document's text changed but its declarations are unchanged (top-level syntax equivalent): only its own
    /// slice of every entry is re-searched. Also correct for a document that was added or removed when the caller
    /// invalidates the owning projects as well.
    /// </summary>
    public void InvalidateDocumentReferences(DocumentId documentId)
    {
        foreach (var (_, entry) in _entries)
        {
            lock (entry.Gate)
            {
                entry.ByDocument.Remove(documentId);
                entry.Stale.Add(documentId);
            }
        }
    }

    /// <summary>
    /// Declarations in <paramref name="projects"/> changed: entries of symbols declared in them are dropped, and every
    /// document of those projects (source-generated ones included) is re-searched for the other entries. Pass the
    /// changed projects together with every project that depends on them.
    /// </summary>
    public void InvalidateProjects(IReadOnlyCollection<ProjectId> projects)
    {
        if (projects.Count == 0)
        {
            return;
        }

        var set = projects.ToHashSet();
        foreach (var (key, entry) in _entries)
        {
            lock (entry.Gate)
            {
                if (entry.DefinitionProject is null || set.Contains(entry.DefinitionProject))
                {
                    _entries.TryRemove(key, out _);
                    continue;
                }

                foreach (var id in entry.ByDocument.Keys.Where(d => set.Contains(d.ProjectId)).ToList())
                {
                    entry.ByDocument.Remove(id);
                }

                entry.StaleProjects.UnionWith(set);
            }
        }
    }

    public void Clear() => _entries.Clear();

    public async Task<IReadOnlyList<CallerEdge>> GetReferencesAsync(ISymbol symbol, Solution solution, CancellationToken cancellationToken)
    {
        var key = SymbolKeyOf(symbol, solution);
        var entry = _entries.GetOrAdd(key, _ => new Entry(solution.GetProject(symbol.OriginalDefinition.ContainingAssembly)?.Id, DefinitionDocumentsOf(symbol, solution)));

        IReadOnlyList<(DocumentId Document, TextSpan Span)> positions;
        await entry.Lock.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            if (entry.Complete && entry.Stale.Count == 0 && entry.StaleProjects.Count == 0)
            {
                Interlocked.Increment(ref _hits);
                positions = entry.Snapshot();
            }
            else
            {
                IImmutableSet<Document>? scope = null;
                List<DocumentId> staleDocuments;
                List<ProjectId> staleProjects;
                lock (entry.Gate)
                {
                    staleDocuments = entry.Stale.ToList();
                    staleProjects = entry.StaleProjects.ToList();
                }

                if (entry.Complete)
                {
                    scope = await ScopeAsync(solution, staleDocuments, staleProjects, cancellationToken).ConfigureAwait(false);
                }

                Interlocked.Increment(ref scope is null ? ref _searches : ref _scopedSearches);
                var found = await FindAsync(symbol, solution, scope, cancellationToken).ConfigureAwait(false);
                lock (entry.Gate)
                {
                    if (scope is not null)
                    {
                        var projects = staleProjects.ToHashSet();
                        foreach (var id in entry.ByDocument.Keys.Where(d => projects.Contains(d.ProjectId)).Concat(staleDocuments).ToList())
                        {
                            entry.ByDocument.Remove(id);
                        }

                        entry.Stale.ExceptWith(staleDocuments);
                        entry.StaleProjects.ExceptWith(staleProjects);
                    }
                    else
                    {
                        entry.ByDocument.Clear();
                        entry.Stale.Clear();
                        entry.StaleProjects.Clear();
                    }

                    foreach (var group in found.GroupBy(e => e.Document))
                    {
                        entry.ByDocument[group.Key] = group.Select(e => e.Span).ToList();
                    }

                    entry.Complete = true;
                }

                positions = entry.Snapshot();
            }
        }
        finally
        {
            entry.Lock.Release();
        }

        return await MapAsync(positions, solution, cancellationToken).ConfigureAwait(false);
    }

    private static async Task<IImmutableSet<Document>> ScopeAsync(Solution solution, IReadOnlyList<DocumentId> documents, IReadOnlyList<ProjectId> projects, CancellationToken cancellationToken)
    {
        var scope = new HashSet<Document>();
        foreach (var id in documents)
        {
            var document = solution.GetDocument(id) ?? await solution.GetSourceGeneratedDocumentAsync(id, cancellationToken).ConfigureAwait(false);
            if (document is not null)
            {
                scope.Add(document);
            }
        }

        foreach (var project in projects.Select(solution.GetProject).OfType<Project>())
        {
            scope.UnionWith(project.Documents);
            scope.UnionWith(await project.GetSourceGeneratedDocumentsAsync(cancellationToken).ConfigureAwait(false));
        }

        return scope.ToImmutableHashSet();
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

    private static async Task<List<(DocumentId Document, TextSpan Span)>> FindAsync(ISymbol symbol, Solution solution, IImmutableSet<Document>? documents, CancellationToken cancellationToken)
    {
        var results = new List<(DocumentId Document, TextSpan Span)>();
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
                if (location.Location.IsInSource)
                {
                    results.Add((location.Document.Id, location.Location.SourceSpan));
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

    /// <summary>Maps reference positions to their enclosing members on the semantic model of <paramref name="solution"/>.</summary>
    private static async Task<IReadOnlyList<CallerEdge>> MapAsync(IReadOnlyList<(DocumentId Document, TextSpan Span)> positions, Solution solution, CancellationToken cancellationToken)
    {
        var edges = new List<CallerEdge>(positions.Count);
        foreach (var group in positions.GroupBy(p => p.Document))
        {
            // A document is always searched in (or invalidated for) the snapshot it is mapped in, so it exists here;
            // source-generated documents are looked up separately.
            var document = solution.GetDocument(group.Key)
                ?? await solution.GetSourceGeneratedDocumentAsync(group.Key, cancellationToken).ConfigureAwait(false);
            if (document is null)
            {
                continue;
            }

            var root = await document.GetSyntaxRootAsync(cancellationToken).ConfigureAwait(false);
            var model = await document.GetSemanticModelAsync(cancellationToken).ConfigureAwait(false);
            if (root is null || model is null)
            {
                continue;
            }

            foreach (var (_, span) in group)
            {
                var callers = EnclosingMembers(root, model, span.Start, cancellationToken);
                if (!callers.IsDefaultOrEmpty)
                {
                    edges.Add(new CallerEdge(callers, document.Id, span.Start, ClassifyUsage(root, span)));
                }
            }
        }

        return edges;
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
        public Entry(ProjectId? definitionProject, HashSet<DocumentId> definitionDocuments)
        {
            DefinitionProject = definitionProject;
            DefinitionDocuments = definitionDocuments;
        }

        public object Gate { get; } = new();

        public SemaphoreSlim Lock { get; } = new(1, 1);

        public ProjectId? DefinitionProject { get; }

        public HashSet<DocumentId> DefinitionDocuments { get; }

        public Dictionary<DocumentId, List<TextSpan>> ByDocument { get; } = new();

        public HashSet<DocumentId> Stale { get; } = new();

        /// <summary>Projects all of whose documents must be searched again.</summary>
        public HashSet<ProjectId> StaleProjects { get; } = new();

        public bool Complete { get; set; }

        public IReadOnlyList<(DocumentId Document, TextSpan Span)> Snapshot()
        {
            lock (Gate)
            {
                return ByDocument.SelectMany(pair => pair.Value.Select(span => (pair.Key, span))).ToList();
            }
        }
    }
}
