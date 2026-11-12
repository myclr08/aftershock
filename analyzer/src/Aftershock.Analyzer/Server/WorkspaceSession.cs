using System.Collections.Concurrent;
using System.Collections.Immutable;
using System.Diagnostics;
using Aftershock.Analyzer.Engine;
using Aftershock.Analyzer.Git;
using Aftershock.Analyzer.Output;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.MSBuild;
using Microsoft.CodeAnalysis.Text;

namespace Aftershock.Analyzer.Server;

/// <summary>
/// A warm <see cref="MSBuildWorkspace"/> for the server mode.
/// <para>
/// State: <c>_solution</c> is the server's view of the files on disk (every document text is pinned in memory, so
/// Roslyn never re-reads a newer version of a file behind our back). <c>_pending</c> holds, for every C# file whose
/// last analyzed content differs from its content in <c>_solution</c>, that last analyzed content (null: the file did
/// not exist). <c>impact</c> diffs pending content against disk and advances the snapshots only when the analysis is
/// committed; a cancelled request leaves them pending, so the next <c>impact</c> includes them.
/// </para>
/// <para>All workspace mutations and analyses are serialized by one async lock. A reload loads a new workspace
/// outside the lock and swaps it in under the lock, so requests keep being answered meanwhile.</para>
/// </summary>
public sealed partial class WorkspaceSession : IDisposable
{
    private const int MaxScannedFiles = 200_000;

    private static readonly HashSet<string> SkippedFolders = new(StringComparer.OrdinalIgnoreCase)
    {
        "bin", "obj", "TestResults", ".vs", ".idea", ".git", "node_modules",
    };

    private readonly SemaphoreSlim _lock = new(1, 1);
    private readonly object _stateGate = new();
    private readonly CancellationTokenSource _lifetime = new();
    private readonly ReferenceCache _cache = new();
    private readonly Func<AnalysisLog> _createLog;

    // Guarded by _stateGate (read by status without the workspace lock); mutated under the workspace lock.
    private readonly Dictionary<string, string?> _pending = new(PathUtil.Comparer);
    private readonly Dictionary<string, long> _dirtyProjects = new(PathUtil.Comparer);
    private long _allDirtyGeneration;

    // Files named by impact requests that have not been committed yet (also those of requests still waiting or
    // cancelled). Owned by the host so requests that arrive before the workspace is loaded are not lost.
    private readonly ConcurrentDictionary<string, byte> _requested;

    // Reload coordination, guarded by _reloadGate.
    private readonly object _reloadGate = new();
    private readonly List<(long Generation, TaskCompletionSource<ReloadOutcome> Waiter)> _reloadWaiters = new();
    private readonly List<string> _reloadReasons = new();
    private long _reloadRequested;
    private bool _reloadRunning;

    private MSBuildWorkspace _workspace;
    private Solution _solution;
    private Solution? _cacheSolution;
    private HashSet<string> _excluded;
    private WorkspaceInfo _info;
    private bool _disposed;

    private WorkspaceSession(string solutionPath, string? repositoryRoot, LoadedWorkspace loaded, Func<AnalysisLog> createLog, ConcurrentDictionary<string, byte> requested)
    {
        _requested = requested;
        SolutionPath = solutionPath;
        SolutionDirectory = Path.GetDirectoryName(solutionPath)!;
        RepositoryRoot = repositoryRoot;
        _createLog = createLog;
        _workspace = loaded.Workspace;
        _solution = loaded.Solution;
        _excluded = loaded.Excluded;
        _info = loaded.Info(1);
        LoadDiagnostics = loaded.Diagnostics;
    }

    public string SolutionPath { get; }

    public string SolutionDirectory { get; }

    /// <summary>Root of the git work tree, or null when the solution is not in one (base mode is unavailable then).</summary>
    public string? RepositoryRoot { get; }

    /// <summary>Root for display paths and fallback globs: the repository root, else the solution folder.</summary>
    public string DisplayRoot => RepositoryRoot ?? SolutionDirectory;

    public WorkspaceInfo Info => _info;

    public IReadOnlyList<DiagnosticReport> LoadDiagnostics { get; private set; }

    /// <summary>
    /// Diagnostics aid (used by the tests): every analysis is repeated with an empty reference cache and any difference
    /// in the selected tests or fallbacks is recorded in <see cref="CacheMismatches"/> and logged as an error.
    /// </summary>
    internal bool VerifyCache { get; set; }

    internal List<string> CacheMismatches { get; } = new();

    /// <summary>Raised (on a background thread) when a reload starts; the argument is the reason.</summary>
    public event Action<string>? ReloadStarted;

    /// <summary>Raised (on a background thread) after every reload attempt.</summary>
    public event Action<ReloadOutcome>? Reloaded;

    /// <summary>Creates the set the host uses to register requested files (see <see cref="NoteRequested"/>).</summary>
    public static ConcurrentDictionary<string, byte> CreateRequestedSet() => new(PathUtil.Comparer);

    /// <summary>Loads the solution. MSBuild must be registered.</summary>
    /// <param name="solutionPath">Solution file.</param>
    /// <param name="createLog">Creates the log of a background operation (load, reload).</param>
    /// <param name="requested">Files named by impact requests not analyzed yet; shared with the host.</param>
    /// <param name="cancellationToken">Cancels the load.</param>
    public static async Task<WorkspaceSession> OpenAsync(string solutionPath, Func<AnalysisLog> createLog, ConcurrentDictionary<string, byte>? requested, CancellationToken cancellationToken)
    {
        solutionPath = PathUtil.Normalize(solutionPath);
        if (!File.Exists(solutionPath))
        {
            throw new SessionException(JsonRpcErrorCodes.WorkspaceUnavailable, $"solution file not found: {solutionPath}");
        }

        var log = createLog();
        string? repositoryRoot = null;
        try
        {
            repositoryRoot = await new GitClient(Path.GetDirectoryName(solutionPath)!).GetTopLevelAsync(cancellationToken).ConfigureAwait(false);
        }
        catch (InvalidOperationException ex)
        {
            log.Warning("workspace", $"git is not available ({ex.Message}); base mode is disabled");
        }

        if (repositoryRoot is not null)
        {
            repositoryRoot = PathUtil.Normalize(repositoryRoot);
        }
        else
        {
            log.Info("the solution is not inside a git work tree; impactSinceBase is unavailable");
        }

        var loaded = await LoadAsync(solutionPath, log, cancellationToken).ConfigureAwait(false);
        return new WorkspaceSession(solutionPath, repositoryRoot, loaded, createLog, requested ?? CreateRequestedSet());
    }

    /// <summary>
    /// Prepares the first request: creates the compilations of every project, then runs one reference search from the
    /// project most others depend on, which builds the per-document search indexes and JIT-compiles the search path.
    /// </summary>
    public async Task<long> WarmUpAsync(CancellationToken cancellationToken)
    {
        await _lock.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            var watch = Stopwatch.StartNew();
            var solution = _solution;
            await Task.WhenAll(solution.Projects.Select(p => p.GetCompilationAsync(cancellationToken))).ConfigureAwait(false);

            var graph = solution.GetProjectDependencyGraph();
            var root = solution.Projects
                .OrderByDescending(p => graph.GetProjectsThatTransitivelyDependOnThisProject(p.Id).Count())
                .FirstOrDefault();
            if (root is not null && await root.GetCompilationAsync(cancellationToken).ConfigureAwait(false) is { } compilation)
            {
                // A long (rare) name: the search still indexes every document that could reference it, but binds few.
                var probe = compilation.Assembly.GlobalNamespace.GetMembers()
                    .SelectMany(AllTypes)
                    .SelectMany(t => t.GetMembers())
                    .Where(m => m is IMethodSymbol { MethodKind: MethodKind.Ordinary } && m.Locations.Any(l => l.IsInSource))
                    .Take(500)
                    .OrderByDescending(m => m.Name.Length)
                    .FirstOrDefault();
                if (probe is not null)
                {
                    await Microsoft.CodeAnalysis.FindSymbols.SymbolFinder.FindReferencesAsync(probe, solution, cancellationToken).ConfigureAwait(false);
                }
            }

            _info.WarmUpMs = watch.ElapsedMilliseconds;
            return _info.WarmUpMs;
        }
        finally
        {
            _lock.Release();
        }

        static IEnumerable<INamedTypeSymbol> AllTypes(INamespaceOrTypeSymbol container) =>
            container.GetMembers().SelectMany(member => member switch
            {
                INamespaceSymbol ns => AllTypes(ns),
                INamedTypeSymbol type => new[] { type }.Concat(AllTypes(type)),
                _ => Enumerable.Empty<INamedTypeSymbol>(),
            });
    }

    /// <summary>
    /// Registers files named by an impact request as soon as it arrives (before it waits for the lock). They are
    /// analyzed by the first impact request that commits, so a cancelled or superseded request loses nothing.
    /// </summary>
    public void NoteRequested(IEnumerable<string> paths)
    {
        foreach (var path in paths)
        {
            _requested[path] = 0;
        }
    }

    /// <summary>
    /// Snapshot mode: analyzes <paramref name="files"/> (plus every file left pending by earlier requests) against the
    /// last analyzed content, using the content on disk as the new state.
    /// </summary>
    public async Task<ImpactReport> ImpactAsync(IReadOnlyList<string> files, AnalysisSettings settings, IRequestContext context, CancellationToken cancellationToken)
    {
        var total = Stopwatch.StartNew();
        NoteRequested(files);
        context.Phase("queued");
        await _lock.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            ThrowIfDisposed();
            var durations = new Dictionary<string, long> { ["queue"] = total.ElapsedMilliseconds };
            var log = context.CreateLog();

            context.Phase("updateWorkspace");
            var updateWatch = Stopwatch.StartNew();
            List<string> paths;
            lock (_stateGate)
            {
                paths = files.Concat(_requested.Keys).Concat(_pending.Keys)
                    .Distinct(PathUtil.Comparer)
                    .OrderBy(p => p, StringComparer.Ordinal)
                    .ToList();
            }

            var model = new SolutionModel(_solution);
            var globs = settings.FallbackGlobs.Select(g => new GlobMatcher(g)).ToList();
            var changes = new List<FileChange>();
            var hostFallbacks = new List<HostFallback>();
            var processed = new List<string>();
            var reloadTriggers = new List<(string Display, IReadOnlyList<Project> Projects, bool Rebuild)>();
            foreach (var path in paths)
            {
                cancellationToken.ThrowIfCancellationRequested();
                var display = PathUtil.ToGitPath(DisplayRoot, path);
                if (!IsCSharp(path))
                {
                    processed.Add(path);
                    var change = new FileChange(path, File.Exists(path) ? FileChangeKind.Modified : FileChangeKind.Deleted, DisplayPath: display);
                    changes.Add(change);
                    if (PathUtil.PathEquals(path, SolutionPath))
                    {
                        reloadTriggers.Add((display, Array.Empty<Project>(), false));
                    }
                    else if (FallbackPlanner.Classify(change, model, globs, DisplayRoot, SolutionDirectory) is FallbackDisposition { Kind: FallbackKinds.BuildFile } build)
                    {
                        reloadTriggers.Add((display, build.Projects, true));
                    }

                    continue;
                }

                var disk = await ApplyDiskAsync(path, model, log, cancellationToken).ConfigureAwait(false);
                if (disk.Error is not null)
                {
                    // The file stays pending; the next request reads it again.
                    var owners = OwningProjectIds(model, path);
                    hostFallbacks.Add(new HostFallback(FallbackKinds.Error, display, $"could not read {display}: {disk.Error}", owners));
                    continue;
                }

                processed.Add(path);
                string? old;
                lock (_stateGate)
                {
                    if (!_pending.TryGetValue(path, out old))
                    {
                        continue;
                    }
                }

                if (string.Equals(old, disk.Text, StringComparison.Ordinal))
                {
                    continue;
                }

                var kind = old is null ? (_excluded.Contains(path) ? FileChangeKind.Modified : FileChangeKind.Added)
                    : disk.Text is null ? FileChangeKind.Deleted
                    : FileChangeKind.Modified;
                changes.Add(new FileChange(path, kind, OldText: old, NewText: disk.Text, DisplayPath: display));
            }

            if (changes.Any(c => c.IsCSharp))
            {
                hostFallbacks.AddRange(ReloadingFallbacks());
            }

            durations["workspaceUpdate"] = updateWatch.ElapsedMilliseconds;
            var result = await AnalyzeAsync(changes, settings, hostFallbacks, log, context, durations, cancellationToken).ConfigureAwait(false);

            if (!context.TryCommit())
            {
                throw new OperationCanceledException(cancellationToken);
            }

            lock (_stateGate)
            {
                foreach (var path in processed)
                {
                    _pending.Remove(path);
                    _requested.TryRemove(path, out _);
                }
            }

            foreach (var trigger in reloadTriggers)
            {
                _ = ScheduleReload(trigger.Display, trigger.Projects, trigger.Rebuild);
            }

            durations["total"] = total.ElapsedMilliseconds;
            return BuildReport(result, durations, log, null, null, null);
        }
        finally
        {
            _lock.Release();
        }
    }

    /// <summary>
    /// Base mode: analyzes the changes between a git revision (by default the merge base of HEAD and it) and the
    /// working tree, like the CLI's <c>--base</c>, on the warm workspace. Snapshots do not advance.
    /// </summary>
    public async Task<ImpactReport> ImpactSinceBaseAsync(string baseRef, bool mergeBase, IReadOnlyList<string>? files, AnalysisSettings settings, IRequestContext context, CancellationToken cancellationToken)
    {
        var total = Stopwatch.StartNew();
        if (RepositoryRoot is null)
        {
            throw new SessionException(JsonRpcErrorCodes.InvalidRequest, $"{SolutionDirectory} is not inside a git work tree; impactSinceBase is unavailable");
        }

        context.Phase("queued");
        await _lock.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            ThrowIfDisposed();
            var durations = new Dictionary<string, long> { ["queue"] = total.ElapsedMilliseconds };
            var log = context.CreateLog();

            context.Phase("git");
            var gitWatch = Stopwatch.StartNew();
            var git = new GitClient(RepositoryRoot);
            var commit = mergeBase
                ? await git.MergeBaseAsync("HEAD", baseRef, cancellationToken).ConfigureAwait(false)
                : await git.ResolveCommitAsync(baseRef, cancellationToken).ConfigureAwait(false);
            if (commit is null)
            {
                throw new SessionException(
                    JsonRpcErrorCodes.InvalidParams,
                    mergeBase ? $"no merge base of HEAD and '{baseRef}' (does it resolve to a commit?)" : $"'{baseRef}' does not resolve to a commit");
            }

            var changes = await GitChangeCollector.CollectAsync(git, RepositoryRoot, commit, cancellationToken).ConfigureAwait(false);
            durations["git"] = gitWatch.ElapsedMilliseconds;
            log.Info($"git: {changes.Count} changed file(s) against {baseRef}{(mergeBase ? " (merge base with HEAD)" : string.Empty)} ({commit[..12]})");

            context.Phase("updateWorkspace");
            var updateWatch = Stopwatch.StartNew();
            var model = new SolutionModel(_solution);
            var hostFallbacks = new List<HostFallback>();
            foreach (var path in changes.SelectMany(c => new[] { c.Path, c.OldPath }).OfType<string>().Where(IsCSharp).Distinct(PathUtil.Comparer))
            {
                var disk = await ApplyDiskAsync(path, model, log, cancellationToken).ConfigureAwait(false);
                if (disk.Error is not null)
                {
                    var display = PathUtil.ToGitPath(DisplayRoot, path);
                    hostFallbacks.Add(new HostFallback(FallbackKinds.Error, display, $"could not read {display}: {disk.Error}", OwningProjectIds(model, path)));
                }
            }

            if (files is not null)
            {
                var wanted = files.ToHashSet(PathUtil.Comparer);
                changes = changes.Where(c => wanted.Contains(c.Path) || (c.OldPath is not null && wanted.Contains(c.OldPath))).ToList();
            }

            if (changes.Any(c => c.IsCSharp))
            {
                hostFallbacks.AddRange(ReloadingFallbacks());
            }

            durations["workspaceUpdate"] = updateWatch.ElapsedMilliseconds;
            var result = await AnalyzeAsync(changes, settings, hostFallbacks, log, context, durations, cancellationToken).ConfigureAwait(false);
            durations["total"] = total.ElapsedMilliseconds;
            return BuildReport(result, durations, log, baseRef, commit, mergeBase ? "HEAD" : null);
        }
        finally
        {
            _lock.Release();
        }
    }

    /// <summary>Requests a full reload and completes when a reload that started after this call has finished.</summary>
    public Task<ReloadOutcome> ReloadAsync(string reason) => ScheduleReload(reason, Array.Empty<Project>(), markDirty: false);

    public SessionStatus GetStatus()
    {
        lock (_stateGate)
        {
            bool reloading;
            lock (_reloadGate)
            {
                reloading = _reloadRunning;
            }

            return new SessionStatus
            {
                Workspace = _info,
                Reloading = reloading,
                AllProjectsDirty = _allDirtyGeneration > 0,
                DirtyProjects = _dirtyProjects.Keys.OrderBy(p => p, StringComparer.Ordinal).ToList(),
                PendingFiles = _pending.Keys.Concat(_requested.Keys).Distinct(PathUtil.Comparer).OrderBy(p => p, StringComparer.Ordinal).ToList(),
                CachedSymbols = _cache.Count,
                CacheSearches = _cache.Searches,
                CacheScopedSearches = _cache.ScopedSearches,
                CacheHits = _cache.Hits,
            };
        }
    }

    public void Dispose()
    {
        if (_disposed)
        {
            return;
        }

        _disposed = true;
        _lifetime.Cancel();
        lock (_reloadGate)
        {
            foreach (var (_, waiter) in _reloadWaiters)
            {
                waiter.TrySetCanceled();
            }

            _reloadWaiters.Clear();
        }

        _workspace.Dispose();
    }

    private async Task<ImpactResult> AnalyzeAsync(
        IReadOnlyList<FileChange> changes,
        AnalysisSettings settings,
        List<HostFallback> hostFallbacks,
        AnalysisLog log,
        IRequestContext context,
        Dictionary<string, long> durations,
        CancellationToken cancellationToken)
    {
        var syncWatch = Stopwatch.StartNew();
        await SyncCacheAsync(cancellationToken).ConfigureAwait(false);
        durations["cacheSync"] = syncWatch.ElapsedMilliseconds;

        var options = new ImpactOptions
        {
            MaxSymbols = settings.MaxSymbols,
            Timeout = TimeSpan.FromSeconds(settings.TimeoutSeconds),
            FallbackGlobs = settings.FallbackGlobs,
            RepositoryRoot = DisplayRoot,
            CompileErrors = CompileErrorCheck.ChangedDocuments,
            HostFallbacks = hostFallbacks,
            OnPhase = context.Phase,
        };

        var engine = new ImpactEngine(log, _cache);
        var result = await engine.AnalyzeAsync(_solution, changes, options, cancellationToken).ConfigureAwait(false);
        foreach (var (key, value) in result.DurationsMs)
        {
            durations[key] = value;
        }

        if (VerifyCache)
        {
            var uncached = await new ImpactEngine(new AnalysisLog(null), new ReferenceCache())
                .AnalyzeAsync(_solution, changes, options with { OnPhase = null }, cancellationToken).ConfigureAwait(false);
            var expected = Describe(uncached);
            var actual = Describe(result);
            if (expected != actual)
            {
                var message = $"cached analysis differs from an uncached one:\n  cached:   {actual}\n  uncached: {expected}";
                CacheMismatches.Add(message);
                log.Error("analysis", message);
            }
        }

        return result;

        static string Describe(ImpactResult r) =>
            string.Join(";", r.Tests.Select(t => t.FullyQualifiedName + "@" + t.Project).OrderBy(n => n, StringComparer.Ordinal))
            + " | fallback: " + string.Join(";", (r.Fallback?.TestProjects ?? new List<string>()).OrderBy(p => p, StringComparer.Ordinal));
    }

    private ImpactReport BuildReport(ImpactResult result, Dictionary<string, long> durations, AnalysisLog log, string? baseRef, string? baseCommit, string? mergeBaseOf)
    {
        return new ImpactReport
        {
            Solution = SolutionPath,
            RepositoryRoot = DisplayRoot,
            Base = baseRef,
            BaseCommit = baseCommit,
            MergeBaseOf = mergeBaseOf,
            DurationsMs = durations,
            ChangedFiles = result.ChangedFiles,
            ChangedSymbols = result.ChangedSymbols,
            Fallback = result.Fallback,
            Tests = result.Tests,
            TestProjects = result.TestProjects,
            Stats = result.Stats,
            Diagnostics = log.Diagnostics.ToList(),
        };
    }

    /// <summary>
    /// Brings the reference cache in line with <c>_solution</c>. A document whose declarations did not change (top-level
    /// syntax equivalent: only bodies and non-constant initializers differ) only has its own references re-searched;
    /// any other change invalidates its project and every project depending on it (binding there may change).
    /// </summary>
    private async Task SyncCacheAsync(CancellationToken cancellationToken)
    {
        var current = _solution;
        var previous = _cacheSolution;
        _cacheSolution = current;
        if (previous is null || previous.Id != current.Id)
        {
            _cache.Clear();
            return;
        }

        if (ReferenceEquals(previous, current))
        {
            return;
        }

        var changes = current.GetChanges(previous);
        if (changes.GetAddedProjects().Any() || changes.GetRemovedProjects().Any())
        {
            _cache.Clear();
            return;
        }

        var declarationChanges = new HashSet<ProjectId>();
        var bodyChanges = new HashSet<ProjectId>();
        foreach (var projectChanges in changes.GetProjectChanges())
        {
            var projectId = projectChanges.ProjectId;
            if (projectChanges.GetAddedDocuments().Any() || projectChanges.GetRemovedDocuments().Any()
                || projectChanges.GetAddedProjectReferences().Any() || projectChanges.GetRemovedProjectReferences().Any()
                || projectChanges.GetAddedMetadataReferences().Any() || projectChanges.GetRemovedMetadataReferences().Any()
                || projectChanges.OldProject.CompilationOptions != projectChanges.NewProject.CompilationOptions
                || projectChanges.OldProject.ParseOptions != projectChanges.NewProject.ParseOptions)
            {
                declarationChanges.Add(projectId);
            }

            foreach (var documentId in projectChanges.GetChangedDocuments(onlyGetDocumentsWithTextChanges: true))
            {
                var oldDocument = previous.GetDocument(documentId);
                var newDocument = current.GetDocument(documentId);
                if (oldDocument is null || newDocument is null)
                {
                    declarationChanges.Add(projectId);
                    continue;
                }

                var oldRoot = await oldDocument.GetSyntaxRootAsync(cancellationToken).ConfigureAwait(false);
                var newRoot = await newDocument.GetSyntaxRootAsync(cancellationToken).ConfigureAwait(false);
                if (oldRoot is not null && newRoot is not null && oldRoot.IsEquivalentTo(newRoot, topLevel: true))
                {
                    _cache.InvalidateDocumentReferences(documentId);
                    bodyChanges.Add(projectId);
                }
                else
                {
                    declarationChanges.Add(projectId);
                }
            }
        }

        // Source generators may read method bodies: their output in the edited projects is searched again too.
        foreach (var project in bodyChanges.Except(declarationChanges).Select(current.GetProject).OfType<Project>())
        {
            foreach (var generated in await project.GetSourceGeneratedDocumentsAsync(cancellationToken).ConfigureAwait(false))
            {
                _cache.InvalidateDocumentReferences(generated.Id);
            }
        }

        if (declarationChanges.Count > 0)
        {
            var model = new SolutionModel(current);
            _cache.InvalidateProjects(model.WithDependents(declarationChanges).Select(p => p.Id).ToList());
        }
    }

    /// <summary>
    /// Reads a C# file and brings <c>_solution</c> in line with it, recording the last analyzed content in
    /// <c>_pending</c> before the first change. New files are added to the C# project(s) owning their folder (SDK
    /// default globbing); files that existed below a project at load time without being part of it stay out.
    /// </summary>
    private async Task<(string? Text, string? Error)> ApplyDiskAsync(string path, SolutionModel model, AnalysisLog log, CancellationToken cancellationToken)
    {
        var ids = model.DocumentsAt(path).Where(id => _solution.GetDocument(id) is not null).ToList();
        string? current = null;
        if (ids.Count > 0)
        {
            current = (await _solution.GetDocument(ids[0])!.GetTextAsync(cancellationToken).ConfigureAwait(false)).ToString();
        }

        var (text, error) = await ReadFileAsync(path, cancellationToken).ConfigureAwait(false);
        if (error is not null)
        {
            log.Warning("workspace", $"could not read {path}: {error}");
            return (null, error);
        }

        if (string.Equals(current, text, StringComparison.Ordinal))
        {
            return (text, null);
        }

        lock (_stateGate)
        {
            _pending.TryAdd(path, current);
        }

        if (text is null)
        {
            if (ids.Count > 0)
            {
                _solution = _solution.RemoveDocuments(ids.ToImmutableArray());
                log.Debug($"removed {path} from the workspace");
            }
        }
        else if (ids.Count > 0)
        {
            _solution = _solution.WithDocumentText(ids, SourceText.From(text), PreservationMode.PreserveValue);
        }
        else if (!_excluded.Contains(path))
        {
            AddNewDocument(path, text, model, log);
        }

        return (text, null);
    }

    private void AddNewDocument(string path, string text, SolutionModel model, AnalysisLog log)
    {
        var owners = model.OwningProjects(path).Where(p => p.Language == LanguageNames.CSharp).ToList();
        foreach (var project in owners)
        {
            var projectDirectory = PathUtil.DirectoryOf(project.FilePath)!;
            if (FallbackPlanner.IsInGeneratedFolder(path, projectDirectory))
            {
                continue;
            }

            var folders = Path.GetRelativePath(projectDirectory, Path.GetDirectoryName(path)!)
                .Split(new[] { Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar }, StringSplitOptions.RemoveEmptyEntries)
                .Where(f => f != ".")
                .ToList();
            _solution = _solution.AddDocument(DocumentId.CreateNewId(project.Id, path), Path.GetFileName(path), SourceText.From(text), folders, path);
            log.Info($"new file {PathUtil.ToGitPath(DisplayRoot, path)} added to {project.Name} (project folder; SDK default compile items assumed)");
        }
    }

    private static IReadOnlyList<ProjectId> OwningProjectIds(SolutionModel model, string path)
    {
        var documents = model.DocumentsAt(path);
        return documents.Count > 0
            ? documents.Select(d => d.ProjectId).Distinct().ToList()
            : model.OwningProjects(path).Select(p => p.Id).ToList();
    }

    private IReadOnlyList<HostFallback> ReloadingFallbacks()
    {
        List<ProjectId> projects;
        lock (_stateGate)
        {
            if (_allDirtyGeneration == 0 && _dirtyProjects.Count == 0)
            {
                return Array.Empty<HostFallback>();
            }

            projects = _solution.Projects
                .Where(p => _allDirtyGeneration > 0 || (p.FilePath is not null && _dirtyProjects.ContainsKey(PathUtil.Normalize(p.FilePath))))
                .Select(p => p.Id)
                .ToList();
        }

        return new[]
        {
            new HostFallback(
                FallbackKinds.WorkspaceReloading,
                null,
                "the workspace is being reloaded after a build file change; dependent test projects run completely until the reload is done",
                projects),
        };
    }

    private static async Task<(string? Text, string? Error)> ReadFileAsync(string path, CancellationToken cancellationToken)
    {
        // Editors and formatters may still hold the file for a moment after the save notification.
        for (var attempt = 0; ; attempt++)
        {
            try
            {
                if (!File.Exists(path))
                {
                    return (null, null);
                }

                var bytes = await File.ReadAllBytesAsync(path, cancellationToken).ConfigureAwait(false);
                return (TextDecoding.Decode(bytes), null);
            }
            catch (Exception ex) when (ex is FileNotFoundException or DirectoryNotFoundException)
            {
                return (null, null);
            }
            catch (Exception ex) when ((ex is IOException or UnauthorizedAccessException) && attempt < 4)
            {
                await Task.Delay(50 * (attempt + 1), cancellationToken).ConfigureAwait(false);
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                return (null, ex.Message);
            }
        }
    }

    private static bool IsCSharp(string path) => path.EndsWith(".cs", StringComparison.OrdinalIgnoreCase);

    private void ThrowIfDisposed()
    {
        if (_disposed)
        {
            throw new OperationCanceledException("the session is shutting down");
        }
    }
}
