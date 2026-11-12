using System.Diagnostics;
using Aftershock.Analyzer.Engine;
using Aftershock.Analyzer.Git;
using Aftershock.Analyzer.Output;
using Aftershock.Analyzer.Workspace;

namespace Aftershock.Analyzer.Cli;

/// <summary>The one-shot <c>impact</c> command: git → workspace → engine → report.</summary>
public static class ImpactCommand
{
    /// <summary>Runs the command. MSBuild must already be registered (see <see cref="MSBuildSetup"/>).</summary>
    public static async Task<int> RunAsync(ImpactCommandOptions options, TextWriter stdout, TextWriter stderr, CancellationToken cancellationToken = default)
    {
        var log = new AnalysisLog(stderr, options.Verbose);
        var total = Stopwatch.StartNew();
        var durations = new Dictionary<string, long>();

        var solutionPath = PathUtil.Normalize(options.Solution);
        if (!File.Exists(solutionPath))
        {
            await stderr.WriteLineAsync($"error: solution file not found: {solutionPath}").ConfigureAwait(false);
            return CliOptions.ExitUsage;
        }

        var solutionDirectory = Path.GetDirectoryName(solutionPath)!;

        try
        {
            // Git first: it is fast and a bad ref should fail before the slow workspace load.
            var gitWatch = Stopwatch.StartNew();
            var git = new GitClient(solutionDirectory);
            var repositoryRoot = await git.GetTopLevelAsync(cancellationToken).ConfigureAwait(false);
            if (repositoryRoot is null)
            {
                await stderr.WriteLineAsync($"error: {solutionDirectory} is not inside a git work tree").ConfigureAwait(false);
                return CliOptions.ExitFatal;
            }

            repositoryRoot = PathUtil.Normalize(repositoryRoot);
            var rootGit = new GitClient(repositoryRoot);
            var baseCommit = await rootGit.ResolveCommitAsync(options.Base, cancellationToken).ConfigureAwait(false);
            if (baseCommit is null)
            {
                await stderr.WriteLineAsync($"error: '{options.Base}' does not resolve to a commit").ConfigureAwait(false);
                return CliOptions.ExitUsage;
            }

            var changes = await GitChangeCollector.CollectAsync(rootGit, repositoryRoot, baseCommit, cancellationToken).ConfigureAwait(false);
            durations["git"] = gitWatch.ElapsedMilliseconds;
            log.Info($"git: {changes.Count} changed file(s) against {options.Base} ({baseCommit[..12]}) in {durations["git"]} ms");

            var loadWatch = Stopwatch.StartNew();
            var (workspace, solution) = await WorkspaceLoader.LoadAsync(solutionPath, log, cancellationToken).ConfigureAwait(false);
            using var _ = workspace;
            durations["workspaceLoad"] = loadWatch.ElapsedMilliseconds;
            log.Info($"workspace loaded in {durations["workspaceLoad"]} ms");

            var engine = new ImpactEngine(log);
            var engineOptions = new ImpactOptions
            {
                MaxSymbols = options.MaxSymbols,
                Timeout = TimeSpan.FromSeconds(options.TimeoutSeconds),
                FallbackGlobs = options.FallbackGlobs,
                RepositoryRoot = repositoryRoot,
            };

            var result = await engine.AnalyzeAsync(solution, changes, engineOptions, cancellationToken).ConfigureAwait(false);
            foreach (var (key, value) in result.DurationsMs)
            {
                durations[key] = value;
            }

            durations["total"] = total.ElapsedMilliseconds;
            log.Info("durations (ms): " + string.Join(", ", durations.Select(d => $"{d.Key}={d.Value}")));

            var report = new ImpactReport
            {
                Solution = solutionPath,
                RepositoryRoot = repositoryRoot,
                Base = options.Base,
                BaseCommit = baseCommit,
                DurationsMs = durations,
                ChangedFiles = result.ChangedFiles,
                ChangedSymbols = result.ChangedSymbols,
                Fallback = result.Fallback,
                Tests = result.Tests,
                TestProjects = result.TestProjects,
                Stats = result.Stats,
                Diagnostics = log.Diagnostics.ToList(),
            };

            if (options.Json)
            {
                await stdout.WriteLineAsync(ReportJson.Serialize(report)).ConfigureAwait(false);
            }
            else
            {
                TextReport.Write(report, stdout);
            }

            await stdout.FlushAsync(cancellationToken).ConfigureAwait(false);
            return CliOptions.ExitSuccess;
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            await stderr.WriteLineAsync("error: cancelled").ConfigureAwait(false);
            return CliOptions.ExitFatal;
        }
        catch (Exception ex)
        {
            await stderr.WriteLineAsync($"error: {ex.Message}").ConfigureAwait(false);
            await stderr.WriteLineAsync(ex.ToString()).ConfigureAwait(false);
            return CliOptions.ExitFatal;
        }
    }
}
