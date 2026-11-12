using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Aftershock.Analyzer.Output;

// The JSON contract of `aftershock-analyzer impact --json`. Documented in docs/analyzer-cli.md.
// Additive changes keep schemaVersion; breaking changes bump it.

public sealed class ImpactReport
{
    public const int CurrentSchemaVersion = 1;

    public int SchemaVersion { get; init; } = CurrentSchemaVersion;

    public ToolInfo Tool { get; init; } = new();

    public string Solution { get; init; } = string.Empty;

    public string RepositoryRoot { get; init; } = string.Empty;

    /// <summary>The git ref as given. Not present in server snapshot mode (<c>impact</c>), which compares with the last analyzed content.</summary>
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Base { get; init; }

    /// <summary>The commit compared with. Not present in server snapshot mode.</summary>
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? BaseCommit { get; init; }

    /// <summary>
    /// Server base mode only: set to "HEAD" when <see cref="BaseCommit"/> is the merge base of HEAD and <see cref="Base"/>
    /// rather than the commit <see cref="Base"/> points to.
    /// </summary>
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? MergeBaseOf { get; init; }

    public Dictionary<string, long> DurationsMs { get; init; } = new();

    public List<ChangedFileReport> ChangedFiles { get; init; } = new();

    public List<ChangedSymbolReport> ChangedSymbols { get; init; } = new();

    [JsonIgnore(Condition = JsonIgnoreCondition.Never)]
    public FallbackReport? Fallback { get; init; }

    public List<TestReport> Tests { get; init; } = new();

    public List<TestProjectReport> TestProjects { get; init; } = new();

    public StatsReport Stats { get; init; } = new();

    public List<DiagnosticReport> Diagnostics { get; init; } = new();
}

public sealed class ToolInfo
{
    public string Name { get; init; } = "aftershock-analyzer";

    public string Version { get; init; } = Current;

    /// <summary>Informational version without the source revision suffix, e.g. "0.2.0-rc.1".</summary>
    public static string Current { get; } = ReadVersion();

    private static string ReadVersion()
    {
        var assembly = typeof(ToolInfo).Assembly;
        var informational = assembly.GetCustomAttributes(typeof(System.Reflection.AssemblyInformationalVersionAttribute), false)
            .OfType<System.Reflection.AssemblyInformationalVersionAttribute>()
            .FirstOrDefault()?.InformationalVersion;
        if (!string.IsNullOrEmpty(informational))
        {
            var plus = informational.IndexOf('+');
            return plus > 0 ? informational[..plus] : informational;
        }

        return assembly.GetName().Version?.ToString(3) ?? "0.0.0";
    }
}

public sealed class ChangedFileReport
{
    /// <summary>Repository-relative path (forward slashes) as reported by git.</summary>
    public string Path { get; init; } = string.Empty;

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? OldPath { get; init; }

    public string FullPath { get; init; } = string.Empty;

    /// <summary>added | modified | deleted | renamed | untracked</summary>
    public string Status { get; init; } = string.Empty;

    /// <summary>selective | fallback | ignored</summary>
    public string Analysis { get; set; } = "ignored";

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Note { get; set; }
}

public sealed class ChangedSymbolReport
{
    public string Symbol { get; init; } = string.Empty;

    /// <summary>method | constructor | staticConstructor | destructor | operator | conversion | property | indexer | getter | setter | init | event | field | enumMember | type | entryPoint</summary>
    public string Kind { get; init; } = string.Empty;

    public string File { get; init; } = string.Empty;

    public int Line { get; init; }

    /// <summary>modified | added | deleted | typeChanged | fileChanged | newFile | deletedFile</summary>
    public string Reason { get; init; } = string.Empty;

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Detail { get; init; }
}

public sealed class FallbackReport
{
    public List<FallbackReasonReport> Reasons { get; init; } = new();

    /// <summary>Absolute paths of test projects that must run completely.</summary>
    public List<string> TestProjects { get; init; } = new();
}

public sealed class FallbackReasonReport
{
    /// <summary>buildFile | fallbackGlob | entryPoint | diRegistration | notInWorkspace | unsupportedFile | bfsLimit | timeout | error | assemblySetup</summary>
    public string Kind { get; init; } = string.Empty;

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? File { get; init; }

    public string Message { get; init; } = string.Empty;

    public List<string> TestProjects { get; init; } = new();
}

public sealed class TestReport
{
    /// <summary>Namespace.Class.Method as reported by the VSTest adapters (nested classes use '+'), without arguments.</summary>
    public string FullyQualifiedName { get; init; } = string.Empty;

    public string ClassName { get; init; } = string.Empty;

    public string MethodName { get; init; } = string.Empty;

    /// <summary>xunit | nunit | mstest</summary>
    public string Framework { get; init; } = string.Empty;

    /// <summary>
    /// True for data-driven tests (xUnit Theory, NUnit TestCase/TestCaseSource/parameters, MSTest DataRow/DynamicData).
    /// NUnit's adapter appends the arguments to FullyQualifiedName for these.
    /// </summary>
    public bool Parameterized { get; init; }

    /// <summary>Absolute path of the test project file the test runs in.</summary>
    public string Project { get; init; } = string.Empty;

    public string ProjectName { get; init; } = string.Empty;

    public string File { get; init; } = string.Empty;

    public int Line { get; init; }

    /// <summary>changedTest | referenceChain | classLifecycle | fixture | dataSource</summary>
    public string Reason { get; init; } = string.Empty;

    /// <summary>Ordered from the changed symbol to the test, e.g. ["TaxRates.ForCountry", "PriceCalculator.Tax", "PriceCalculatorTests.Total_IncludesTax"].</summary>
    public List<string> Chain { get; init; } = new();

    /// <summary>Set when the test method is declared in a base class of <see cref="ClassName"/>.</summary>
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? DeclaredIn { get; init; }
}

public sealed class TestProjectReport
{
    public string Name { get; init; } = string.Empty;

    public string Path { get; init; } = string.Empty;

    /// <summary>filter: run only <see cref="Tests"/> entries of this project; all: run the whole project (fallback).</summary>
    public string Mode { get; init; } = "filter";

    /// <summary>Number of selected test methods in this project.</summary>
    public int Tests { get; init; }

    public List<string> Frameworks { get; init; } = new();
}

public sealed class StatsReport
{
    public int VisitedSymbols { get; set; }

    /// <summary>Full reference searches (every document of the solution that can reference the symbol).</summary>
    public int ReferenceSearches { get; set; }

    /// <summary>Lookups answered from the reference cache without searching.</summary>
    public int CacheHits { get; set; }

    /// <summary>
    /// Server only: cached lookups that re-searched just the documents changed since the entry was cached. Omitted
    /// when zero (always in the one-shot CLI, whose cache starts empty).
    /// </summary>
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingDefault)]
    public int ScopedSearches { get; set; }
}

public sealed record DiagnosticReport(string Severity, string Source, string Message);

public static class ReportJson
{
    public static readonly JsonSerializerOptions Options = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        WriteIndented = true,
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
        DefaultIgnoreCondition = JsonIgnoreCondition.Never,
    };

    public static string Serialize(ImpactReport report) => JsonSerializer.Serialize(report, Options);

    public static ImpactReport? Deserialize(string json) => JsonSerializer.Deserialize<ImpactReport>(json, Options);
}
