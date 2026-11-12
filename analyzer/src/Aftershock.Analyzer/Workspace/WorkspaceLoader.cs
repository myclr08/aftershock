using Aftershock.Analyzer.Engine;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.MSBuild;

namespace Aftershock.Analyzer.Workspace;

/// <summary>Loads a solution with <see cref="MSBuildWorkspace"/>; every load problem is logged, never swallowed.</summary>
public static class WorkspaceLoader
{
    public static async Task<(MSBuildWorkspace Workspace, Solution Solution)> LoadAsync(string solutionPath, AnalysisLog log, CancellationToken cancellationToken = default)
    {
        var workspace = MSBuildWorkspace.Create();
        workspace.RegisterWorkspaceFailedHandler(e =>
        {
            var kind = e.Diagnostic.Kind == WorkspaceDiagnosticKind.Failure ? "error" : "warning";
            if (kind == "error")
            {
                log.Error("workspace", e.Diagnostic.Message);
            }
            else
            {
                log.Warning("workspace", e.Diagnostic.Message);
            }
        });

        var solution = await workspace.OpenSolutionAsync(solutionPath, progress: null, cancellationToken: cancellationToken).ConfigureAwait(false);
        var projectCount = solution.ProjectIds.Count;
        var documentCount = solution.Projects.Sum(p => p.DocumentIds.Count);
        log.Info($"workspace: {projectCount} project(s), {documentCount} document(s)");
        if (projectCount == 0)
        {
            log.Error("workspace", $"no projects were loaded from {solutionPath}");
        }

        return (workspace, solution);
    }
}
