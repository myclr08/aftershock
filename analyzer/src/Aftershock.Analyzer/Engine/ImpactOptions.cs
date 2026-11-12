using Microsoft.CodeAnalysis;

namespace Aftershock.Analyzer.Engine;

/// <summary>How much of the affected compilations is checked for compile errors before the search.</summary>
public enum CompileErrorCheck
{
    /// <summary>Every changed project and every project depending on it (one-shot CLI: compiled once anyway).</summary>
    AffectedProjects,

    /// <summary>
    /// Only the changed documents. Used by the server: binding whole dependent projects again on every save would
    /// cost more than the analysis itself, and errors elsewhere are already known from earlier requests.
    /// </summary>
    ChangedDocuments,
}

/// <summary>A fallback decided by the host (for example a project waiting for a workspace reload) rather than by the engine.</summary>
/// <param name="Kind">One of <see cref="FallbackKinds"/>.</param>
/// <param name="File">Display path of the file that caused it, if any.</param>
/// <param name="Message">Human-readable reason.</param>
/// <param name="Projects">Projects whose dependent test projects must run completely.</param>
public sealed record HostFallback(string Kind, string? File, string Message, IReadOnlyList<ProjectId> Projects);

public sealed record ImpactOptions
{
    public static readonly IReadOnlyList<string> DefaultFallbackGlobs = new[] { "**/appsettings*.json" };

    /// <summary>Maximum number of symbols visited by the caller search for one changed file before falling back.</summary>
    public int MaxSymbols { get; init; } = 500;

    /// <summary>Time budget for the reference search phase (all files together).</summary>
    public TimeSpan Timeout { get; init; } = TimeSpan.FromSeconds(10);

    /// <summary>Globs (relative to the repository root or the solution directory) that trigger a project fallback.</summary>
    public IReadOnlyList<string> FallbackGlobs { get; init; } = DefaultFallbackGlobs;

    /// <summary>Root used to compute relative paths for glob matching. Defaults to the solution directory.</summary>
    public string? RepositoryRoot { get; init; }

    /// <summary>Degree of parallelism used when expanding one BFS level.</summary>
    public int MaxParallelism { get; init; } = Math.Max(2, Environment.ProcessorCount);

    /// <summary>Which compilations are checked for compile errors (reported as warnings) before the search.</summary>
    public CompileErrorCheck CompileErrors { get; init; } = CompileErrorCheck.AffectedProjects;

    /// <summary>Fallbacks added by the host; they are reported like the engine's own.</summary>
    public IReadOnlyList<HostFallback> HostFallbacks { get; init; } = Array.Empty<HostFallback>();

    /// <summary>Called when the engine enters a phase (classify, compile, resolve, search, report). Must not throw.</summary>
    public Action<string>? OnPhase { get; init; }
}
