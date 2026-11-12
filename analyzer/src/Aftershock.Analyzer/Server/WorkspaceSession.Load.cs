using System.Diagnostics;
using Aftershock.Analyzer.Engine;
using Aftershock.Analyzer.Git;
using Aftershock.Analyzer.Output;
using Aftershock.Analyzer.Workspace;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.MSBuild;
using Microsoft.CodeAnalysis.Text;

namespace Aftershock.Analyzer.Server;

/// <summary>Loading, pinning and background reloads of the workspace.</summary>
public sealed partial class WorkspaceSession
{
    private Task<ReloadOutcome> ScheduleReload(string reason, IReadOnlyList<Project> dirtyProjects, bool markDirty)
    {
        var waiter = new TaskCompletionSource<ReloadOutcome>(TaskCreationOptions.RunContinuationsAsynchronously);
        bool start;
        lock (_reloadGate)
        {
            if (_disposed)
            {
                waiter.TrySetCanceled();
                return waiter.Task;
            }

            var generation = ++_reloadRequested;
            _reloadReasons.Add(reason);
            if (markDirty)
            {
                lock (_stateGate)
                {
                    if (dirtyProjects.Count == 0 || dirtyProjects.Count == _solution.ProjectIds.Count)
                    {
                        _allDirtyGeneration = generation;
                    }
                    else
                    {
                        foreach (var project in new SolutionModel(_solution).WithDependents(dirtyProjects.Select(p => p.Id)))
                        {
                            if (project.FilePath is not null)
                            {
                                _dirtyProjects[PathUtil.Normalize(project.FilePath)] = generation;
                            }
                        }
                    }
                }
            }

            _reloadWaiters.Add((generation, waiter));
            start = !_reloadRunning;
            _reloadRunning = true;
        }

        if (start)
        {
            _ = Task.Run(ReloadLoopAsync);
        }

        return waiter.Task;
    }

    private async Task ReloadLoopAsync()
    {
        while (true)
        {
            long target;
            string reason;
            lock (_reloadGate)
            {
                if (_reloadWaiters.Count == 0 || _disposed)
                {
                    _reloadRunning = false;
                    return;
                }

                target = _reloadRequested;
                reason = string.Join(", ", _reloadReasons.Distinct(StringComparer.Ordinal));
                _reloadReasons.Clear();
            }

            ReloadOutcome outcome;
            try
            {
                outcome = await ReloadOnceAsync(reason, _lifetime.Token).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (_lifetime.IsCancellationRequested)
            {
                lock (_reloadGate)
                {
                    _reloadRunning = false;
                    foreach (var (_, waiter) in _reloadWaiters)
                    {
                        waiter.TrySetCanceled();
                    }

                    _reloadWaiters.Clear();
                }

                return;
            }
            catch (Exception ex)
            {
                _createLog().Error("workspace", $"reload failed ({reason}): {ex}");
                outcome = new ReloadOutcome { Success = false, Reason = reason, Error = ex.Message };
            }

            lock (_reloadGate)
            {
                if (outcome.Success)
                {
                    lock (_stateGate)
                    {
                        if (_allDirtyGeneration <= target)
                        {
                            _allDirtyGeneration = 0;
                        }

                        foreach (var key in _dirtyProjects.Where(p => p.Value <= target).Select(p => p.Key).ToList())
                        {
                            _dirtyProjects.Remove(key);
                        }
                    }
                }

                foreach (var item in _reloadWaiters.Where(w => w.Generation <= target).ToList())
                {
                    item.Waiter.TrySetResult(outcome);
                    _reloadWaiters.Remove(item);
                }
            }

            try
            {
                Reloaded?.Invoke(outcome);
            }
            catch (Exception)
            {
                // A listener failure must not stop the reload loop.
            }
        }
    }

    private async Task<ReloadOutcome> ReloadOnceAsync(string reason, CancellationToken cancellationToken)
    {
        var watch = Stopwatch.StartNew();
        ReloadStarted?.Invoke(reason);
        var log = _createLog();
        LoadedWorkspace loaded;
        try
        {
            loaded = await LoadAsync(SolutionPath, log, cancellationToken).ConfigureAwait(false);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            log.Error("workspace", $"reload failed, keeping the previous workspace: {ex.Message}");
            return new ReloadOutcome { Success = false, Reason = reason, DurationMs = watch.ElapsedMilliseconds, Error = ex.Message, Diagnostics = log.Diagnostics.ToList() };
        }

        if (loaded.Solution.ProjectIds.Count == 0)
        {
            loaded.Workspace.Dispose();
            const string message = "reload loaded no projects, keeping the previous workspace";
            log.Error("workspace", message);
            return new ReloadOutcome { Success = false, Reason = reason, DurationMs = watch.ElapsedMilliseconds, Error = message, Diagnostics = log.Diagnostics.ToList() };
        }

        List<string> pendingFiles;
        await _lock.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            if (_disposed)
            {
                loaded.Workspace.Dispose();
                throw new OperationCanceledException(cancellationToken);
            }

            await RecordReloadDifferencesAsync(_solution, loaded.Solution, cancellationToken).ConfigureAwait(false);
            var old = _workspace;
            _workspace = loaded.Workspace;
            _solution = loaded.Solution;
            _excluded = loaded.Excluded;
            _cache.Clear();
            _cacheSolution = null;
            _info = loaded.Info(_info.Generation + 1);
            LoadDiagnostics = loaded.Diagnostics;
            old.Dispose();
            lock (_stateGate)
            {
                pendingFiles = _pending.Keys.OrderBy(p => p, StringComparer.Ordinal).ToList();
            }
        }
        finally
        {
            _lock.Release();
        }

        await WarmUpAsync(cancellationToken).ConfigureAwait(false);
        log.Info($"workspace reloaded ({reason}) in {watch.ElapsedMilliseconds} ms: {_info.Projects} project(s), {_info.Documents} document(s), {pendingFiles.Count} pending file(s)");
        return new ReloadOutcome
        {
            Success = true,
            Reason = reason,
            DurationMs = watch.ElapsedMilliseconds,
            Workspace = _info,
            PendingFiles = pendingFiles,
            Diagnostics = log.Diagnostics.ToList(),
        };
    }

    /// <summary>
    /// Files whose content differs between the old and the reloaded workspace (changed on disk without being reported,
    /// or added to / removed from a project) keep their last analyzed content as pending, so the next impact reports them.
    /// </summary>
    private async Task RecordReloadDifferencesAsync(Solution oldSolution, Solution newSolution, CancellationToken cancellationToken)
    {
        var oldTexts = await TextsByPathAsync(oldSolution, cancellationToken).ConfigureAwait(false);
        var newTexts = await TextsByPathAsync(newSolution, cancellationToken).ConfigureAwait(false);
        lock (_stateGate)
        {
            foreach (var path in oldTexts.Keys.Concat(newTexts.Keys).Distinct(PathUtil.Comparer))
            {
                oldTexts.TryGetValue(path, out var oldText);
                newTexts.TryGetValue(path, out var newText);
                var same = oldText is not null && newText is not null ? oldText.ContentEquals(newText) : oldText is null && newText is null;
                if (!same)
                {
                    _pending.TryAdd(path, oldText?.ToString());
                }
            }
        }
    }

    private static async Task<Dictionary<string, SourceText>> TextsByPathAsync(Solution solution, CancellationToken cancellationToken)
    {
        var result = new Dictionary<string, SourceText>(PathUtil.Comparer);
        foreach (var document in solution.Projects.SelectMany(p => p.Documents))
        {
            if (document.FilePath is null || !IsCSharp(document.FilePath))
            {
                continue;
            }

            var path = PathUtil.Normalize(document.FilePath);
            if (!result.ContainsKey(path))
            {
                result[path] = await document.GetTextAsync(cancellationToken).ConfigureAwait(false);
            }
        }

        return result;
    }

    private static async Task<LoadedWorkspace> LoadAsync(string solutionPath, AnalysisLog log, CancellationToken cancellationToken)
    {
        var watch = Stopwatch.StartNew();
        var (workspace, solution) = await WorkspaceLoader.LoadAsync(solutionPath, log, cancellationToken).ConfigureAwait(false);
        try
        {
            solution = await PinTextsAsync(solution, log, cancellationToken).ConfigureAwait(false);
            var excluded = ScanExcludedFiles(solution);
            if (excluded.Count > 0)
            {
                log.Debug($"{excluded.Count} C# file(s) below project folders are not part of any project");
            }

            return new LoadedWorkspace(workspace, solution, excluded, watch.ElapsedMilliseconds, log.Diagnostics.ToList());
        }
        catch
        {
            workspace.Dispose();
            throw;
        }
    }

    /// <summary>
    /// Replaces every document's file-backed text with the content read now. Roslyn may drop a file-backed text from
    /// memory and read the file again later, which would silently turn the last analyzed content into the newest one.
    /// Files are read with the same decoding as later saves, so an unchanged file never shows a spurious diff.
    /// </summary>
    private static async Task<Solution> PinTextsAsync(Solution solution, AnalysisLog log, CancellationToken cancellationToken)
    {
        var documents = solution.Projects.SelectMany(p => p.Documents).ToList();
        var texts = new SourceText?[documents.Count];
        await Parallel.ForEachAsync(
            Enumerable.Range(0, documents.Count),
            new ParallelOptions { MaxDegreeOfParallelism = Math.Max(2, Environment.ProcessorCount), CancellationToken = cancellationToken },
            async (i, token) =>
            {
                var document = documents[i];
                try
                {
                    if (document.FilePath is not null && File.Exists(document.FilePath))
                    {
                        texts[i] = SourceText.From(TextDecoding.Decode(await File.ReadAllBytesAsync(document.FilePath, token).ConfigureAwait(false)));
                    }
                    else
                    {
                        texts[i] = await document.GetTextAsync(token).ConfigureAwait(false);
                    }
                }
                catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
                {
                    log.Warning("workspace", $"could not read {document.FilePath}: {ex.Message}");
                }
            }).ConfigureAwait(false);

        for (var i = 0; i < documents.Count; i++)
        {
            if (texts[i] is { } text)
            {
                solution = solution.WithDocumentText(documents[i].Id, text, PreservationMode.PreserveValue);
            }
        }

        return solution;
    }

    /// <summary>C# files below project folders (build output excluded) that are not documents of any project.</summary>
    private static HashSet<string> ScanExcludedFiles(Solution solution)
    {
        var documents = new HashSet<string>(
            solution.Projects.SelectMany(p => p.Documents).Select(d => d.FilePath).OfType<string>().Select(PathUtil.Normalize),
            PathUtil.Comparer);
        var excluded = new HashSet<string>(PathUtil.Comparer);
        var visited = new HashSet<string>(PathUtil.Comparer);
        var scanned = 0;
        var stack = new Stack<string>(solution.Projects.Select(p => PathUtil.DirectoryOf(p.FilePath)).OfType<string>().Distinct(PathUtil.Comparer));
        while (stack.Count > 0 && scanned < MaxScannedFiles)
        {
            var directory = stack.Pop();
            if (!visited.Add(directory))
            {
                continue;
            }

            try
            {
                // The extension is checked again: on Windows "*.cs" also matches longer extensions.
                foreach (var file in Directory.EnumerateFiles(directory, "*.cs").Where(IsCSharp))
                {
                    scanned++;
                    var path = PathUtil.Normalize(file);
                    if (!documents.Contains(path))
                    {
                        excluded.Add(path);
                    }
                }

                foreach (var child in Directory.EnumerateDirectories(directory))
                {
                    if (!SkippedFolders.Contains(Path.GetFileName(child)))
                    {
                        stack.Push(PathUtil.Normalize(child));
                    }
                }
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                // Unreadable folders cannot contain files we would be asked about.
            }
        }

        return excluded;
    }

    private sealed record LoadedWorkspace(MSBuildWorkspace Workspace, Solution Solution, HashSet<string> Excluded, long LoadMs, List<DiagnosticReport> Diagnostics)
    {
        public WorkspaceInfo Info(int generation)
        {
            var model = new SolutionModel(Solution);
            return new WorkspaceInfo
            {
                Generation = generation,
                Projects = Solution.ProjectIds.Count,
                Documents = Solution.Projects.Sum(p => p.DocumentIds.Count),
                LoadMs = LoadMs,
                TestProjects = model.TestProjects(Solution)
                    .Select(p => new TestProjectInfo(p.Name, p.FilePath ?? p.Name, model.FrameworksOf(p)))
                    .OrderBy(p => p.Path, StringComparer.Ordinal)
                    .ToList(),
            };
        }
    }
}
