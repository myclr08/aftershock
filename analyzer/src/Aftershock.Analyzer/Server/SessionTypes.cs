using Aftershock.Analyzer.Engine;
using Aftershock.Analyzer.Output;

namespace Aftershock.Analyzer.Server;

/// <summary>Analysis limits of one request (server defaults, overridable per request).</summary>
public sealed record AnalysisSettings(int MaxSymbols, int TimeoutSeconds, IReadOnlyList<string> FallbackGlobs);

/// <summary>What the host of a session provides to one request.</summary>
public interface IRequestContext
{
    /// <summary>Reports a phase change (sent as a <c>progress</c> notification by the server).</summary>
    void Phase(string phase);

    /// <summary>A log for this request: its warnings and errors end up in the request's <c>diagnostics</c>.</summary>
    AnalysisLog CreateLog();

    /// <summary>
    /// Called once the analysis has finished, right before per-file snapshots advance. Returns false when the request
    /// was cancelled in the meantime (nothing is committed then). After true, the request can no longer be cancelled:
    /// its result must be delivered.
    /// </summary>
    bool TryCommit();
}

/// <summary>An error that maps to a JSON-RPC error response.</summary>
public sealed class SessionException : Exception
{
    public SessionException(int code, string message, object? data = null)
        : base(message)
    {
        Code = code;
        ErrorData = data;
    }

    public int Code { get; }

    public object? ErrorData { get; }
}

public sealed record TestProjectInfo(string Name, string Path, IReadOnlyList<string> Frameworks);

/// <summary>Shape of the loaded workspace, returned by <c>initialize</c>, <c>reload</c> and <c>status</c>.</summary>
public sealed class WorkspaceInfo
{
    /// <summary>Increments with every successful (re)load.</summary>
    public int Generation { get; init; }

    public int Projects { get; init; }

    public int Documents { get; init; }

    public long LoadMs { get; init; }

    public long WarmUpMs { get; set; }

    public List<TestProjectInfo> TestProjects { get; init; } = new();
}

public sealed class ReloadOutcome
{
    public bool Success { get; init; }

    public string Reason { get; init; } = string.Empty;

    public long DurationMs { get; init; }

    public WorkspaceInfo? Workspace { get; init; }

    /// <summary>Files whose content differs from the last analyzed content after the reload; the next <c>impact</c> includes them.</summary>
    public List<string> PendingFiles { get; init; } = new();

    public string? Error { get; init; }

    public List<DiagnosticReport> Diagnostics { get; init; } = new();
}

/// <summary>Snapshot of the session state for <c>status</c>.</summary>
public sealed class SessionStatus
{
    public WorkspaceInfo Workspace { get; init; } = new();

    public bool Reloading { get; init; }

    public bool AllProjectsDirty { get; init; }

    public List<string> DirtyProjects { get; init; } = new();

    public List<string> PendingFiles { get; init; } = new();

    public int CachedSymbols { get; init; }

    public int CacheSearches { get; init; }

    public int CacheScopedSearches { get; init; }

    public int CacheHits { get; init; }
}
