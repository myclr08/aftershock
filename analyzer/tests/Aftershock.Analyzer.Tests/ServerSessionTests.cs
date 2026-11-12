using Aftershock.Analyzer.Cli;
using Aftershock.Analyzer.Engine;
using Aftershock.Analyzer.Server;
using Aftershock.Analyzer.Tests.Infrastructure;
using static Aftershock.Analyzer.Tests.Infrastructure.Expect;

namespace Aftershock.Analyzer.Tests;

/// <summary>
/// The warm session in-process. Every analysis runs with the shared reference cache and again with an empty one
/// (<see cref="WorkspaceSession.VerifyCache"/>): the cache must never change a result, across body edits,
/// declaration changes, test-side changes, reverts and reloads.
/// </summary>
public sealed class ServerSessionTests
{
    private const string Catalog = "src/Sample.Core/Catalog/ProductCatalog.cs";
    private const string TaxRates = "src/Sample.Core/Pricing/TaxRates.cs";
    private const string Calculator = "src/Sample.Core/Pricing/PriceCalculator.cs";
    private const string TaxRatesTests = "tests/Sample.Tests.XUnit/TaxRatesTests.cs";

    private static readonly AnalysisSettings Settings = new(500, 120, ImpactOptions.DefaultFallbackGlobs);

    [Fact]
    public async Task CachedResults_EqualUncachedResults_AcrossEditsRevertsAndReloads()
    {
        using var copy = SampleCopy.Create("cache");
        using var session = await WorkspaceSession.OpenAsync(copy.SolutionPath, () => new AnalysisLog(null), null, CancellationToken.None);
        session.VerifyCache = true;
        await session.WarmUpAsync(CancellationToken.None);

        async Task<Aftershock.Analyzer.Output.ImpactReport> Step(string name, params string[] files)
        {
            var report = await session.ImpactAsync(files.Select(copy.PathOf).Select(PathUtil.Normalize).ToList(), Settings, new Context(), CancellationToken.None);
            Assert.True(session.CacheMismatches.Count == 0, $"{name}: {string.Join("\n", session.CacheMismatches)}");
            Assert.DoesNotContain(report.Diagnostics, d => d.Severity == "error");
            return report;
        }

        // Body edits: the second one is answered from the cache, re-searching only the edited document.
        Edit(copy, Catalog, "_prices.TryGetValue(sku, out var price)", "_prices.TryGetValue(sku.Trim(), out var price)");
        var first = await Step("body edit");
        Assert.Empty(first.ChangedFiles);
        first = await Step("body edit", Catalog);
        Assert.Equal(3, first.Tests.Count);

        Edit(copy, Catalog, "sku.Trim()", "sku.Trim().ToUpperInvariant()");
        var second = await Step("second body edit", Catalog);
        Assert.Equal(3, second.Tests.Count);
        Assert.True(second.Stats.ScopedSearches + second.Stats.CacheHits > 0, "the second edit should use the reference cache");

        Edit(copy, TaxRates, "\"NL\" => 0.21m,", "\"NL\" => 0.21m,\n            \"FR\" => 0.20m,");
        Assert.Equal(5, (await Step("multi-level chain", TaxRates)).Tests.Count);

        // A declaration change (new member) invalidates the project and its dependents.
        Edit(copy, Calculator, "    public decimal Total(Order order)", "    public decimal Discount(Order order) => 0m;\n\n    public decimal Total(Order order)");
        await Step("member added", Calculator);

        Edit(copy, Calculator, "sum += line.UnitPrice * line.Quantity;", "sum += line.Quantity * line.UnitPrice;");
        Assert.NotEmpty((await Step("body edit after a declaration change", Calculator)).Tests);

        // Test-side declaration change, then a signature change with an optional parameter (callers still bind).
        Edit(copy, TaxRatesTests, "public class TaxRatesTests\n{\n", "public class TaxRatesTests\n{\n    [Fact]\n    public void ForCountry_UnknownIsZero() => Assert.Equal(0m, TaxRates.ForCountry(\"XX\"));\n\n");
        await Step("test-side change", TaxRatesTests);
        Edit(copy, Catalog, "public decimal PriceOf(string sku)", "public decimal PriceOf(string sku, bool exact = false)");
        await Step("signature change", Catalog);

        // Revert everything in one request, then edit again.
        ProcessRunner.Git(copy.RepositoryRoot, "checkout", "--", ".");
        var reverted = await Step("revert", Catalog, TaxRates, Calculator, TaxRatesTests);
        Assert.Equal(4, reverted.ChangedFiles.Count);
        Edit(copy, Catalog, "_prices.TryGetValue(sku, out var price)", "_prices.TryGetValue(sku.Trim(), out var price)");
        Selected(await Step("body edit after revert", Catalog),
            XUnit + "CatalogTests.Default_ContainsBook",
            XUnit + "CatalogImportTests.Import_ParsesPrices",
            XUnitV3 + "CatalogV3Tests.PriceOf_Book");

        // A reload clears the cache; an unreported change made on disk before it is kept pending, not swallowed.
        Edit(copy, TaxRates, "\"NL\" => 0.21m,", "\"NL\" => 0.22m,");
        var outcome = await session.ReloadAsync("test");
        Assert.True(outcome.Success, outcome.Error);
        Assert.Equal(2, outcome.Workspace!.Generation);
        Assert.Equal(new[] { copy.PathOf(TaxRates) }.Select(PathUtil.Normalize), outcome.PendingFiles, PathUtil.Comparer);
        var afterReload = await Step("pending after reload");
        Assert.Equal(5, afterReload.Tests.Count);
        Assert.Empty(session.GetStatus().PendingFiles);
    }

    private static void Selected(Aftershock.Analyzer.Output.ImpactReport report, params string[] expected)
    {
        Assert.Equal(expected.OrderBy(n => n, StringComparer.Ordinal), report.Tests.Select(t => t.FullyQualifiedName).OrderBy(n => n, StringComparer.Ordinal));
    }

    private static void Edit(SampleCopy copy, string relativePath, string oldText, string newText)
    {
        var path = copy.PathOf(relativePath);
        var text = File.ReadAllText(path);
        Assert.Contains(oldText, text);
        File.WriteAllText(path, text.Replace(oldText, newText, StringComparison.Ordinal));
    }

    private sealed class Context : IRequestContext
    {
        public void Phase(string phase)
        {
        }

        public AnalysisLog CreateLog() => new(null);

        public bool TryCommit() => true;
    }
}

public sealed class ServerUnitTests
{
    [Theory]
    [InlineData("not json", -32700)]
    [InlineData("[{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"status\"}]", -32600)]
    [InlineData("42", -32600)]
    [InlineData("{\"id\":1,\"method\":\"status\"}", -32600)]
    [InlineData("{\"jsonrpc\":\"1.0\",\"id\":1,\"method\":\"status\"}", -32600)]
    [InlineData("{\"jsonrpc\":\"2.0\",\"id\":1}", -32600)]
    [InlineData("{\"jsonrpc\":\"2.0\",\"id\":{},\"method\":\"status\"}", -32600)]
    [InlineData("{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"impact\",\"params\":[1]}", -32602)]
    public void Parse_RejectsInvalidMessages(string line, int code)
    {
        var (message, _, errorCode, error) = JsonRpcChannel.Parse(line);
        Assert.Null(message);
        Assert.Equal(code, errorCode);
        Assert.False(string.IsNullOrEmpty(error));
    }

    [Fact]
    public void Parse_ReadsRequestsAndNotifications()
    {
        var (request, _, _, _) = JsonRpcChannel.Parse("{\"jsonrpc\":\"2.0\",\"id\":\"a\",\"method\":\"impact\",\"params\":{\"files\":[\"x.cs\"]}}");
        Assert.NotNull(request);
        Assert.Equal("\"a\"", request!.Id);
        Assert.Equal("impact", request.Method);
        Assert.Equal("x.cs", request.Params!.Value.GetProperty("files")[0].GetString());

        var (notification, _, _, _) = JsonRpcChannel.Parse("{\"jsonrpc\":\"2.0\",\"method\":\"$/cancelRequest\",\"params\":{\"id\":3}}");
        Assert.True(notification!.IsNotification);

        // A notification with bad params gets no response (code 0).
        var (_, _, code, _) = JsonRpcChannel.Parse("{\"jsonrpc\":\"2.0\",\"method\":\"exit\",\"params\":5}");
        Assert.Equal(0, code);
    }

    [Fact]
    public void ServeOptions_AreParsed()
    {
        var result = CliOptions.Parse(new[] { "serve", "--solution", "a.sln", "--max-symbols", "7", "--timeout-seconds=3", "--fallback-glob", "**/*.sql", "--verbose" });
        Assert.Null(result.Options);
        var serve = Assert.IsType<ServeCommandOptions>(result.Serve);
        Assert.Equal("a.sln", serve.Solution);
        Assert.Equal(7, serve.MaxSymbols);
        Assert.Equal(3, serve.TimeoutSeconds);
        Assert.Equal(new[] { "**/*.sql" }, serve.FallbackGlobs);
        Assert.True(serve.Verbose);

        Assert.Equal(CliOptions.ExitUsage, CliOptions.Parse(new[] { "serve" }).ExitCode);
        Assert.Equal(CliOptions.ExitUsage, CliOptions.Parse(new[] { "serve", "--solution", "a.sln", "--base", "HEAD" }).ExitCode);
        Assert.Equal(CliOptions.ExitUsage, CliOptions.Parse(new[] { "serve", "--solution", "a.sln", "--json" }).ExitCode);
    }
}
