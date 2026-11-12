using System.Text.Json;
using System.Text.Json.Serialization;
using Aftershock.Analyzer.Output;

namespace Aftershock.Analyzer.Server;

// Result and notification shapes of the server protocol (docs/analyzer-cli.md, "Server mode").
// Additive changes keep ProtocolVersion; breaking changes bump it.

public static class ServerProtocol
{
    public const int ProtocolVersion = 1;
}

public sealed record AnalysisOptionsInfo(int MaxSymbols, int TimeoutSeconds, IReadOnlyList<string> FallbackGlobs);

public sealed record CapabilitiesInfo(bool ImpactSinceBase, bool Cancellation, bool Supersede);

public sealed class InitializeResult
{
    public int ProtocolVersion { get; init; } = ServerProtocol.ProtocolVersion;

    /// <summary>Schema version of the impact reports returned by impact and impactSinceBase.</summary>
    public int SchemaVersion { get; init; } = ImpactReport.CurrentSchemaVersion;

    public ToolInfo Tool { get; init; } = new();

    public string Solution { get; init; } = string.Empty;

    /// <summary>Git work tree root, or null when the solution is not in a git repository.</summary>
    [JsonIgnore(Condition = JsonIgnoreCondition.Never)]
    public string? RepositoryRoot { get; init; }

    public string Msbuild { get; init; } = string.Empty;

    public WorkspaceInfo Workspace { get; init; } = new();

    public AnalysisOptionsInfo Options { get; init; } = new(500, 10, Array.Empty<string>());

    public CapabilitiesInfo Capabilities { get; init; } = new(false, true, true);

    public List<DiagnosticReport> Diagnostics { get; init; } = new();
}

public sealed record InFlightRequest(JsonElement Id, string Method);

public sealed class StatusResult
{
    /// <summary>loading | ready | failed | shuttingDown</summary>
    public string State { get; init; } = "loading";

    public bool Initialized { get; init; }

    public string Solution { get; init; } = string.Empty;

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? RepositoryRoot { get; init; }

    public ToolInfo Tool { get; init; } = new();

    public int ProtocolVersion { get; init; } = ServerProtocol.ProtocolVersion;

    public long UptimeMs { get; init; }

    public long RequestsServed { get; init; }

    public List<InFlightRequest> InFlight { get; init; } = new();

    public AnalysisOptionsInfo Options { get; init; } = new(500, 10, Array.Empty<string>());

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public WorkspaceInfo? Workspace { get; init; }

    public bool Reloading { get; init; }

    public bool AllProjectsDirty { get; init; }

    public List<string> DirtyProjects { get; init; } = new();

    /// <summary>Files whose last change has not been analyzed yet; the next impact includes them.</summary>
    public List<string> PendingFiles { get; init; } = new();

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public CacheInfo? Cache { get; init; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? LoadError { get; init; }
}

public sealed record CacheInfo(int Symbols, int Searches, int ScopedSearches, int Hits);

public sealed record LogParams(string Level, string Message, [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] JsonElement? Id);

public sealed record ProgressParams(
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] JsonElement? Id,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? Method,
    string Phase,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? Message);

public sealed record CancelledData(string Reason, [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] JsonElement? By);
