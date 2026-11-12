namespace Aftershock.Analyzer.Engine;

public sealed class ImpactOptions
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
}
