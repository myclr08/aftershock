using System.Diagnostics;
using Aftershock.Analyzer.Output;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Text;

namespace Aftershock.Analyzer.Engine;

/// <summary>Result of <see cref="ImpactEngine.AnalyzeAsync"/>; the CLI wraps it into an <see cref="ImpactReport"/>.</summary>
public sealed class ImpactResult
{
    public List<ChangedFileReport> ChangedFiles { get; } = new();

    public List<ChangedSymbolReport> ChangedSymbols { get; } = new();

    public FallbackReport? Fallback { get; set; }

    public List<TestReport> Tests { get; } = new();

    public List<TestProjectReport> TestProjects { get; } = new();

    public Dictionary<string, long> DurationsMs { get; } = new();

    public StatsReport Stats { get; } = new();
}

/// <summary>
/// Impact analysis over an already loaded solution. Independent of git and of the CLI: callers provide the
/// current <see cref="Solution"/> (the "new" state) and the changed files with their old content.
/// A <see cref="ReferenceCache"/> can be shared between calls by a long-running host.
/// </summary>
public sealed class ImpactEngine
{
    private readonly AnalysisLog _log;
    private readonly ReferenceCache _cache;

    public ImpactEngine(AnalysisLog log, ReferenceCache? cache = null)
    {
        _log = log;
        _cache = cache ?? new ReferenceCache();
    }

    public ReferenceCache Cache => _cache;

    public async Task<ImpactResult> AnalyzeAsync(Solution solution, IReadOnlyList<FileChange> changes, ImpactOptions options, CancellationToken cancellationToken = default)
    {
        var result = new ImpactResult();
        var searchesBefore = _cache.Searches;
        var scopedBefore = _cache.ScopedSearches;
        var hitsBefore = _cache.Hits;
        options.OnPhase?.Invoke("classify");
        var model = new SolutionModel(solution);
        var testModel = new TestModel(solution, model, _log);
        var solutionDirectory = PathUtil.DirectoryOf(solution.FilePath) ?? Environment.CurrentDirectory;
        var globRoot = options.RepositoryRoot ?? solutionDirectory;
        var globs = options.FallbackGlobs.Select(g => new GlobMatcher(g)).ToList();
        var fallbacks = new List<(FallbackReasonReport Report, IReadOnlyList<Project> Projects)>();
        var stopwatch = Stopwatch.StartNew();

        // 1. Classify files: selective analysis, fallback or ignore.
        var work = new List<FileWork>();
        foreach (var change in Deduplicate(changes).OrderBy(c => c.Display, StringComparer.Ordinal))
        {
            var effective = change;
            var documents = model.DocumentsAt(change.Path);
            if (change.NewText is null && change.Kind != FileChangeKind.Deleted && documents.Count > 0 && change.IsCSharp)
            {
                var text = await solution.GetDocument(documents[0])!.GetTextAsync(cancellationToken).ConfigureAwait(false);
                effective = change with { NewText = text.ToString() };
            }

            var report = new ChangedFileReport
            {
                Path = change.Display,
                OldPath = change.OldDisplayPath,
                FullPath = change.Path,
                Status = change.Untracked ? "untracked" : change.Kind.ToString().ToLowerInvariant(),
            };
            result.ChangedFiles.Add(report);

            FileDisposition disposition;
            try
            {
                disposition = FallbackPlanner.Classify(effective, model, globs, globRoot, solutionDirectory);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                _log.Error("analysis", $"classifying {change.Display} failed: {ex.Message}");
                disposition = new FallbackDisposition(FallbackKinds.Error, $"could not classify {change.Display}: {ex.Message}", model.OwningProjects(change.Path));
            }

            switch (disposition)
            {
                case SelectiveDisposition selective:
                    report.Analysis = "selective";
                    work.Add(new FileWork(effective, report, selective.NewDocuments, selective.OwningProjects));
                    break;
                case FallbackDisposition fallback:
                    report.Analysis = "fallback";
                    report.Note = fallback.Message;
                    fallbacks.Add((new FallbackReasonReport { Kind = fallback.Kind, File = change.Display, Message = fallback.Message }, fallback.Projects));
                    break;
                case IgnoredDisposition ignored:
                    report.Analysis = "ignored";
                    report.Note = ignored.Note;
                    _log.Debug($"ignored {change.Display}: {ignored.Note}");
                    break;
            }
        }

        // 2. Old snapshot fork: the new solution with changed documents reverted to their old text,
        //    deleted documents re-added and added documents removed.
        var oldSolution = solution;
        foreach (var item in work)
        {
            var change = item.Change;
            switch (change.Kind)
            {
                case FileChangeKind.Modified or FileChangeKind.Renamed when change.OldText is not null:
                    oldSolution = oldSolution.WithDocumentText(item.NewDocuments, SourceText.From(change.OldText));
                    item.OldDocuments.AddRange(item.NewDocuments);
                    break;
                case FileChangeKind.Modified or FileChangeKind.Renamed:
                    _log.Warning("analysis", $"no old content for {change.Display}; treating it as a new file");
                    oldSolution = oldSolution.RemoveDocuments(item.NewDocuments.ToImmutableArrayOrEmpty());
                    break;
                case FileChangeKind.Added:
                    oldSolution = oldSolution.RemoveDocuments(item.NewDocuments.ToImmutableArrayOrEmpty());
                    break;
                case FileChangeKind.Deleted when change.OldText is not null:
                    foreach (var project in item.OwningProjects)
                    {
                        var id = DocumentId.CreateNewId(project.Id, change.Display);
                        var folders = FoldersOf(project, change.EffectiveOldPath);
                        oldSolution = oldSolution.AddDocument(id, Path.GetFileName(change.EffectiveOldPath), SourceText.From(change.OldText), folders, change.EffectiveOldPath);
                        item.OldDocuments.Add(id);
                    }

                    break;
                case FileChangeKind.Deleted:
                    _log.Warning("analysis", $"no old content for deleted file {change.Display}; its references cannot be resolved");
                    break;
            }
        }

        // 3. Line diff and syntactic member mapping.
        var times = new PhaseTimes();
        foreach (var item in work)
        {
            try
            {
                item.Pending.AddRange(await MapFileAsync(item, solution, oldSolution, times, cancellationToken).ConfigureAwait(false));
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                _log.Error("analysis", $"mapping changes of {item.Change.Display} failed: {ex}");
                item.Failure = $"could not map changes of {item.Change.Display}: {ex.Message}";
            }
        }

        // 4. Compile what the search will need, in parallel, outside the search time budget.
        options.OnPhase?.Invoke("compile");
        var compileWatch = Stopwatch.StartNew();
        var needsOld = work.Any(w => w.Pending.Any(p => p.InOld));
        var changedDocuments = options.CompileErrors == CompileErrorCheck.ChangedDocuments ? work.SelectMany(w => w.NewDocuments).ToHashSet() : null;
        await WarmUpAsync(solution, model, work.SelectMany(w => w.NewDocuments).Select(d => d.ProjectId), changedDocuments, cancellationToken).ConfigureAwait(false);
        if (needsOld)
        {
            var oldModel = new SolutionModel(oldSolution);
            await WarmUpAsync(oldSolution, oldModel, work.SelectMany(w => w.OldDocuments).Select(d => d.ProjectId), changedDocuments is null ? null : new HashSet<DocumentId>(), cancellationToken).ConfigureAwait(false);
        }

        result.DurationsMs["compilation"] = compileWatch.ElapsedMilliseconds;

        // 5. Resolve symbols.
        options.OnPhase?.Invoke("resolve");
        var mappingWatch = Stopwatch.StartNew();
        foreach (var item in work.Where(w => w.Failure is null))
        {
            try
            {
                foreach (var pending in item.Pending)
                {
                    var resolved = await ResolveAsync(pending, pending.InOld ? oldSolution : solution, cancellationToken).ConfigureAwait(false);
                    if (resolved is { } r && pending.MemberAddedOnly && r.Report.Kind == "type" && IsTestSideType(r.Primary, model, testModel, solution))
                    {
                        // Test classes, fixtures and helpers of test projects: the added member is followed through
                        // its own references; the rest of the type is not considered changed.
                        _log.Debug($"member added to test-side type {r.Report.Symbol}: whole-type rule not applied");
                        continue;
                    }

                    if (resolved is null)
                    {
                        continue;
                    }

                    var (report, seeds, _) = resolved.Value;
                    result.ChangedSymbols.Add(report);
                    item.Seeds.AddRange(seeds.Select(s => new Seed(s, pending.InOld)));
                }
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                _log.Error("analysis", $"resolving symbols of {item.Change.Display} failed: {ex}");
                item.Failure = $"could not resolve symbols of {item.Change.Display}: {ex.Message}";
            }
        }

        result.DurationsMs["diff"] = (long)times.Diff.TotalMilliseconds;
        result.DurationsMs["memberMapping"] = (long)times.Mapping.TotalMilliseconds + mappingWatch.ElapsedMilliseconds;

        // 6. Caller search, one BFS per changed file, under one time budget.
        options.OnPhase?.Invoke("search");
        var searchWatch = Stopwatch.StartNew();
        var context = new SearchContext(solution, needsOld ? oldSolution : null, _cache, new ReferenceCache(), testModel, options, _log);
        var hits = new Dictionary<string, (TestHit Hit, Project Project)>(StringComparer.Ordinal);
        var projectFallbacks = new List<ProjectFallback>();
        using var budget = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        if (options.Timeout > TimeSpan.Zero)
        {
            budget.CancelAfter(options.Timeout);
        }

        var visited = 0;
        foreach (var item in work)
        {
            var groupProjects = item.NewDocuments.Select(d => solution.GetProject(d.ProjectId)).OfType<Project>()
                .Concat(item.OwningProjects)
                .DistinctBy(p => p.Id)
                .ToList();

            if (item.Failure is not null)
            {
                fallbacks.Add((new FallbackReasonReport { Kind = FallbackKinds.Error, File = item.Change.Display, Message = item.Failure }, groupProjects));
                item.Report.Analysis = "fallback";
                item.Report.Note = item.Failure;
                continue;
            }

            if (item.Seeds.Count == 0)
            {
                continue;
            }

            if (budget.IsCancellationRequested && !cancellationToken.IsCancellationRequested)
            {
                AddTimeout(item, groupProjects);
                continue;
            }

            try
            {
                var outcome = await new ImpactSearch(context).RunAsync(item.Seeds, budget.Token).ConfigureAwait(false);
                visited += outcome.Visited;
                if (outcome.AbortReason is not null)
                {
                    fallbacks.Add((new FallbackReasonReport { Kind = FallbackKinds.BfsLimit, File = item.Change.Display, Message = outcome.AbortReason }, groupProjects));
                    item.Report.Analysis = "fallback";
                    item.Report.Note = outcome.AbortReason;
                    continue;
                }

                foreach (var hit in outcome.Tests)
                {
                    var project = solution.GetProject(hit.Class.ContainingAssembly, cancellationToken);
                    if (project is null)
                    {
                        continue;
                    }

                    var key = PathUtil.Normalize(project.FilePath ?? project.Name) + "|" + TestModel.FullName(hit.Class) + "." + hit.Method.Name;
                    if (!hits.TryGetValue(key, out var existing) || existing.Hit.Chain.Count > hit.Chain.Count)
                    {
                        hits[key] = (hit, project);
                    }
                }

                projectFallbacks.AddRange(outcome.ProjectFallbacks);
            }
            catch (OperationCanceledException) when (budget.IsCancellationRequested && !cancellationToken.IsCancellationRequested)
            {
                AddTimeout(item, groupProjects);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                _log.Error("analysis", $"caller search for {item.Change.Display} failed: {ex}");
                fallbacks.Add((new FallbackReasonReport { Kind = FallbackKinds.Error, File = item.Change.Display, Message = $"caller search failed: {ex.Message}" }, groupProjects));
                item.Report.Analysis = "fallback";
                item.Report.Note = ex.Message;
            }
        }

        foreach (var projectFallback in projectFallbacks.DistinctBy(p => (p.Project, p.Message)))
        {
            if (solution.GetProject(projectFallback.Project) is { } project)
            {
                fallbacks.Add((new FallbackReasonReport { Kind = FallbackKinds.AssemblySetup, Message = projectFallback.Message }, new[] { project }));
            }
        }

        result.DurationsMs["referenceSearch"] = searchWatch.ElapsedMilliseconds;
        result.Stats.VisitedSymbols = visited;
        result.Stats.ReferenceSearches = _cache.Searches - searchesBefore + context.OldCache.Searches;
        result.Stats.CacheHits = _cache.Hits - hitsBefore + context.OldCache.Hits;
        result.Stats.ScopedSearches = _cache.ScopedSearches - scopedBefore + context.OldCache.ScopedSearches;

        // 7. Report.
        options.OnPhase?.Invoke("report");
        foreach (var hostFallback in options.HostFallbacks)
        {
            var projects = hostFallback.Projects.Select(solution.GetProject).OfType<Project>().ToList();
            fallbacks.Add((new FallbackReasonReport { Kind = hostFallback.Kind, File = hostFallback.File, Message = hostFallback.Message }, projects));
        }

        BuildTests(result, hits.Values, testModel);
        BuildFallback(result, fallbacks, model);
        BuildTestProjects(result, model, solution);
        result.DurationsMs["engineTotal"] = stopwatch.ElapsedMilliseconds;
        return result;

        void AddTimeout(FileWork item, IReadOnlyList<Project> projects)
        {
            var message = $"analysis time budget of {options.Timeout.TotalSeconds:0.#} s exceeded";
            fallbacks.Add((new FallbackReasonReport { Kind = FallbackKinds.Timeout, File = item.Change.Display, Message = message }, projects));
            item.Report.Analysis = "fallback";
            item.Report.Note = message;
        }
    }

    /// <summary>One entry per path: the first old snapshot and the last new content win.</summary>
    private IEnumerable<FileChange> Deduplicate(IReadOnlyList<FileChange> changes)
    {
        foreach (var group in changes.GroupBy(c => PathUtil.Normalize(c.Path), PathUtil.Comparer))
        {
            var items = group.ToList();
            if (items.Count == 1)
            {
                yield return items[0];
                continue;
            }

            _log.Warning("analysis", $"{items.Count} changes reported for {items[0].Display}; merged into one");
            yield return items[^1] with { OldText = items[0].OldText, OldPath = items[0].OldPath ?? items[^1].OldPath, Kind = items[0].Kind == FileChangeKind.Added ? FileChangeKind.Added : items[^1].Kind };
        }
    }

    private static async Task<IReadOnlyList<PendingChange>> MapFileAsync(FileWork item, Solution solution, Solution oldSolution, PhaseTimes times, CancellationToken cancellationToken)
    {
        var pending = new List<PendingChange>();
        if (item.NewDocuments.Count > 0 && item.OldDocuments.Count > 0)
        {
            foreach (var id in item.NewDocuments)
            {
                var newDocument = solution.GetDocument(id)!;
                var oldDocument = oldSolution.GetDocument(id)!;
                var newText = await newDocument.GetTextAsync(cancellationToken).ConfigureAwait(false);
                var oldText = await oldDocument.GetTextAsync(cancellationToken).ConfigureAwait(false);
                var newRoot = await newDocument.GetSyntaxRootAsync(cancellationToken).ConfigureAwait(false);
                var oldRoot = await oldDocument.GetSyntaxRootAsync(cancellationToken).ConfigureAwait(false);
                if (newRoot is null || oldRoot is null)
                {
                    continue;
                }

                var start = Stopwatch.GetTimestamp();
                var hunks = LineDiff.Compute(oldText, newText);
                var mid = Stopwatch.GetTimestamp();
                pending.AddRange(ChangeMapper.MapHunks(hunks, oldRoot, oldText, id, newRoot, newText, id));
                times.Diff += Stopwatch.GetElapsedTime(start, mid);
                times.Mapping += Stopwatch.GetElapsedTime(mid);
            }
        }
        else if (item.NewDocuments.Count > 0)
        {
            foreach (var id in item.NewDocuments)
            {
                var root = await solution.GetDocument(id)!.GetSyntaxRootAsync(cancellationToken).ConfigureAwait(false);
                pending.AddRange(ChangeMapper.MapWholeFile(root!, id, inOld: false));
            }
        }
        else
        {
            foreach (var id in item.OldDocuments)
            {
                var root = await oldSolution.GetDocument(id)!.GetSyntaxRootAsync(cancellationToken).ConfigureAwait(false);
                pending.AddRange(ChangeMapper.MapWholeFile(root!, id, inOld: true));
            }
        }

        return pending;
    }

    /// <param name="checkedDocuments">
    /// Null: report compile errors of every affected project (binds them completely). Otherwise only the errors of
    /// these documents are reported; the other compilations are created but not bound.
    /// </param>
    private async Task WarmUpAsync(Solution solution, SolutionModel model, IEnumerable<ProjectId> changedProjects, IReadOnlySet<DocumentId>? checkedDocuments, CancellationToken cancellationToken)
    {
        var projects = model.WithDependents(changedProjects.Distinct());
        await Task.WhenAll(projects.Select(async project =>
        {
            var compilation = await project.GetCompilationAsync(cancellationToken).ConfigureAwait(false);
            if (compilation is null)
            {
                return;
            }

            List<Diagnostic> errors;
            if (checkedDocuments is null)
            {
                errors = compilation.GetDiagnostics(cancellationToken).Where(d => d.Severity == DiagnosticSeverity.Error).ToList();
            }
            else
            {
                errors = new List<Diagnostic>();
                foreach (var document in project.Documents.Where(d => checkedDocuments.Contains(d.Id)))
                {
                    var semanticModel = await document.GetSemanticModelAsync(cancellationToken).ConfigureAwait(false);
                    if (semanticModel is not null)
                    {
                        errors.AddRange(semanticModel.GetDiagnostics(cancellationToken: cancellationToken).Where(d => d.Severity == DiagnosticSeverity.Error));
                    }
                }
            }

            if (errors.Count > 0)
            {
                _log.Warning("compilation", $"{project.Name}: {errors.Count} compile error(s); results may be incomplete. First: {errors[0]}");
            }
        })).ConfigureAwait(false);
    }

    /// <summary>True for types of test projects and for any type that declares or inherits test methods.</summary>
    private static bool IsTestSideType(ISymbol symbol, SolutionModel model, TestModel testModel, Solution solution)
    {
        if (symbol is not INamedTypeSymbol type)
        {
            return false;
        }

        var project = solution.GetProject(type.ContainingAssembly);
        if (project is not null && model.IsTestProject(project))
        {
            return true;
        }

        return type.GetMembers().Any(testModel.IsTestMethod) || testModel.GetTestMethods(type).Count > 0;
    }

    private static async Task<(ChangedSymbolReport Report, IReadOnlyList<ISymbol> Seeds, ISymbol Primary)?> ResolveAsync(PendingChange pending, Solution solution, CancellationToken cancellationToken)
    {
        var document = solution.GetDocument(pending.Document);
        if (document is null)
        {
            return null;
        }

        var model = await document.GetSemanticModelAsync(cancellationToken).ConfigureAwait(false);
        if (model is null)
        {
            return null;
        }

        var seeds = new List<ISymbol>();
        ISymbol? primary;
        SyntaxNode reportNode;

        if (pending.TypeNode is { } typeNode)
        {
            var currentTypeNode = await FindSameNodeAsync(document, typeNode, cancellationToken).ConfigureAwait(false);
            if (model.GetDeclaredSymbol(currentTypeNode, cancellationToken) is not INamedTypeSymbol type)
            {
                return null;
            }

            primary = type;
            reportNode = currentTypeNode;
            seeds.AddRange(TypeMembers(type));
        }
        else if (pending.Context is { } context)
        {
            var node = await FindSameNodeAsync(document, context.Node, cancellationToken).ConfigureAwait(false);
            reportNode = node;
            primary = DeclaredSymbol(model, context with { Node = node }, cancellationToken);
            if (primary is null)
            {
                return null;
            }

            if (primary is IFieldSymbol or IEventSymbol && context.Node is BaseFieldDeclarationSyntax fieldDeclaration)
            {
                foreach (var variable in fieldDeclaration.Declaration.Variables)
                {
                    if (model.GetDeclaredSymbol(variable, cancellationToken) is { } variableSymbol)
                    {
                        seeds.Add(variableSymbol);
                    }
                }
            }
            else
            {
                seeds.Add(primary);
            }

            if (pending.IncludeConstructors && primary.ContainingType is { } owner)
            {
                seeds.AddRange(owner.InstanceConstructors);
            }
        }
        else
        {
            return null;
        }

        var line = reportNode.GetLocation().GetLineSpan().StartLinePosition.Line + 1;
        var report = new ChangedSymbolReport
        {
            Symbol = SymbolNames.Full(primary),
            Kind = SymbolNames.Kind(primary),
            File = document.FilePath ?? document.Name,
            Line = line,
            Reason = ReasonName(pending.Reason),
            Detail = pending.Detail ?? (pending.TypeNode is not null ? "all members of the type" : null),
        };

        return (report, seeds, primary);
    }

    /// <summary>Syntax nodes from a reparsed tree are not the ones of the document; find the node with the same span and kind.</summary>
    private static async Task<SyntaxNode> FindSameNodeAsync(Document document, SyntaxNode node, CancellationToken cancellationToken)
    {
        var root = await document.GetSyntaxRootAsync(cancellationToken).ConfigureAwait(false);
        if (root is null || node.SyntaxTree == root.SyntaxTree)
        {
            return node;
        }

        var candidate = root.FindNode(node.Span, getInnermostNodeForTie: false);
        foreach (var ancestor in candidate.AncestorsAndSelf())
        {
            if (ancestor.RawKind == node.RawKind && ancestor.Span == node.Span)
            {
                return ancestor;
            }
        }

        return candidate;
    }

    private static ISymbol? DeclaredSymbol(SemanticModel model, SyntaxContext context, CancellationToken cancellationToken)
    {
        switch (context.Kind)
        {
            case ContextKind.Accessor:
                var accessor = model.GetDeclaredSymbol(context.Node, cancellationToken) as IMethodSymbol;
                return accessor?.MethodKind is MethodKind.EventAdd or MethodKind.EventRemove or MethodKind.EventRaise ? accessor.AssociatedSymbol : accessor;
            case ContextKind.ExpressionBodyGetter:
                return (model.GetDeclaredSymbol(context.Node, cancellationToken) as IPropertySymbol)?.GetMethod;
            case ContextKind.EventField:
            case ContextKind.Field:
                var declaration = (BaseFieldDeclarationSyntax)context.Node;
                return declaration.Declaration.Variables.Select(v => model.GetDeclaredSymbol(v, cancellationToken)).FirstOrDefault(s => s is not null);
            case ContextKind.FieldInitializer:
            case ContextKind.EventFieldInitializer:
                return model.GetDeclaredSymbol(context.Node, cancellationToken);
            case ContextKind.GlobalStatement:
                var unit = context.Node as CompilationUnitSyntax;
                var first = unit?.Members.OfType<GlobalStatementSyntax>().FirstOrDefault();
                return first is null ? null : model.GetEnclosingSymbol(first.SpanStart, cancellationToken);
            default:
                return model.GetDeclaredSymbol(context.Node, cancellationToken);
        }
    }

    /// <summary>Members that are seeds when a whole type is considered changed.</summary>
    internal static IEnumerable<ISymbol> TypeMembers(INamedTypeSymbol type)
    {
        if (type.TypeKind == TypeKind.Delegate)
        {
            yield return type;
        }

        foreach (var member in type.GetMembers())
        {
            switch (member)
            {
                case INamedTypeSymbol:
                    continue;
                case IMethodSymbol { MethodKind: MethodKind.PropertyGet or MethodKind.PropertySet or MethodKind.EventAdd or MethodKind.EventRemove or MethodKind.EventRaise }:
                    continue;
                case IFieldSymbol field when field.IsImplicitlyDeclared || field.AssociatedSymbol is not null:
                    continue;
                default:
                    yield return member;
                    break;
            }
        }
    }

    private static string ReasonName(ChangeReason reason) => reason switch
    {
        ChangeReason.Modified => "modified",
        ChangeReason.Added => "added",
        ChangeReason.Deleted => "deleted",
        ChangeReason.TypeChanged => "typeChanged",
        ChangeReason.FileChanged => "fileChanged",
        ChangeReason.NewFile => "newFile",
        ChangeReason.DeletedFile => "deletedFile",
        _ => reason.ToString(),
    };

    private static IEnumerable<string> FoldersOf(Project project, string path)
    {
        var projectDirectory = PathUtil.DirectoryOf(project.FilePath);
        var fileDirectory = Path.GetDirectoryName(path);
        if (projectDirectory is null || fileDirectory is null || !PathUtil.IsUnder(fileDirectory, projectDirectory))
        {
            return Array.Empty<string>();
        }

        var relative = Path.GetRelativePath(projectDirectory, fileDirectory);
        return relative == "." ? Array.Empty<string>() : relative.Split(Path.DirectorySeparatorChar, StringSplitOptions.RemoveEmptyEntries);
    }

    private static void BuildTests(ImpactResult result, IEnumerable<(TestHit Hit, Project Project)> hits, TestModel testModel)
    {
        foreach (var (hit, project) in hits)
        {
            var info = testModel.GetTestInfo(hit.Method);
            var location = hit.Method.Locations.FirstOrDefault(l => l.IsInSource);
            var className = TestModel.FullName(hit.Class);
            result.Tests.Add(new TestReport
            {
                FullyQualifiedName = className + "." + hit.Method.Name,
                ClassName = className,
                MethodName = hit.Method.Name,
                Framework = info?.Framework ?? "unknown",
                Parameterized = info?.Parameterized ?? false,
                Project = project.FilePath ?? project.Name,
                ProjectName = ProjectDisplayName(project),
                File = location?.SourceTree?.FilePath ?? string.Empty,
                Line = (location?.GetLineSpan().StartLinePosition.Line ?? -1) + 1,
                Reason = hit.Reason,
                Chain = hit.Chain.ToList(),
                DeclaredIn = SymbolEqualityComparer.Default.Equals(hit.Method.ContainingType.OriginalDefinition, hit.Class.OriginalDefinition)
                    ? null
                    : TestModel.FullName(hit.Method.ContainingType),
            });
        }

        result.Tests.Sort((a, b) =>
        {
            var byName = string.CompareOrdinal(a.FullyQualifiedName, b.FullyQualifiedName);
            return byName != 0 ? byName : string.CompareOrdinal(a.Project, b.Project);
        });
    }

    private static void BuildFallback(ImpactResult result, List<(FallbackReasonReport Report, IReadOnlyList<Project> Projects)> fallbacks, SolutionModel model)
    {
        if (fallbacks.Count == 0)
        {
            return;
        }

        var all = new SortedSet<string>(PathUtil.Comparer);
        var report = new FallbackReport();
        foreach (var (reason, projects) in fallbacks)
        {
            var testProjects = model.DependentTestProjects(projects)
                .Select(p => p.FilePath ?? p.Name)
                .Distinct(PathUtil.Comparer)
                .OrderBy(p => p, PathUtil.Comparer)
                .ToList();
            reason.TestProjects.AddRange(testProjects);
            report.Reasons.Add(reason);
            all.UnionWith(testProjects);
        }

        report.TestProjects.AddRange(all);
        result.Fallback = report;
    }

    private static void BuildTestProjects(ImpactResult result, SolutionModel model, Solution solution)
    {
        var fallbackProjects = new HashSet<string>(result.Fallback?.TestProjects ?? new List<string>(), PathUtil.Comparer);
        var selected = result.Tests.GroupBy(t => t.Project, PathUtil.Comparer).ToDictionary(g => g.Key, g => g.Count(), PathUtil.Comparer);
        var paths = new SortedSet<string>(fallbackProjects.Concat(selected.Keys), PathUtil.Comparer);
        foreach (var path in paths)
        {
            var projects = solution.Projects.Where(p => PathUtil.PathEquals(p.FilePath ?? p.Name, path)).ToList();
            var frameworks = projects.SelectMany(model.FrameworksOf).Distinct(StringComparer.Ordinal).OrderBy(f => f, StringComparer.Ordinal).ToList();
            result.TestProjects.Add(new TestProjectReport
            {
                Name = projects.Count > 0 ? ProjectDisplayName(projects[0]) : Path.GetFileNameWithoutExtension(path),
                Path = path,
                Mode = fallbackProjects.Contains(path) ? "all" : "filter",
                Tests = selected.TryGetValue(path, out var count) ? count : 0,
                Frameworks = frameworks,
            });
        }
    }

    /// <summary>Project name without the "(net8.0)" suffix MSBuildWorkspace adds for multi-targeted projects.</summary>
    private static string ProjectDisplayName(Project project)
    {
        var name = project.Name;
        var paren = name.IndexOf('(');
        return paren > 0 && name.EndsWith(')') ? name[..paren] : name;
    }

    private sealed class PhaseTimes
    {
        public TimeSpan Diff { get; set; }

        public TimeSpan Mapping { get; set; }
    }

    private sealed class FileWork
    {
        public FileWork(FileChange change, ChangedFileReport report, IReadOnlyList<DocumentId> newDocuments, IReadOnlyList<Project> owningProjects)
        {
            Change = change;
            Report = report;
            NewDocuments = newDocuments;
            OwningProjects = owningProjects;
        }

        public FileChange Change { get; }

        public ChangedFileReport Report { get; }

        public IReadOnlyList<DocumentId> NewDocuments { get; }

        public IReadOnlyList<Project> OwningProjects { get; }

        public List<DocumentId> OldDocuments { get; } = new();

        public List<PendingChange> Pending { get; } = new();

        public List<Seed> Seeds { get; } = new();

        public string? Failure { get; set; }
    }
}

internal static class ImmutableExtensions
{
    public static System.Collections.Immutable.ImmutableArray<T> ToImmutableArrayOrEmpty<T>(this IEnumerable<T>? items) =>
        items is null ? System.Collections.Immutable.ImmutableArray<T>.Empty : System.Collections.Immutable.ImmutableArray.CreateRange(items);
}
