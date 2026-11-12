using System.Text.Json;
using Aftershock.Analyzer.Engine;
using Aftershock.Analyzer.Tests.Infrastructure;
using static Aftershock.Analyzer.Tests.Infrastructure.Expect;

namespace Aftershock.Analyzer.Tests;

/// <summary>
/// The server mode end to end: a real <c>serve</c> process on a git copy of the sample, driven over stdio with
/// newline-delimited JSON-RPC, editing files on disk between requests exactly like an editor would.
/// </summary>
public sealed class ServerProtocolTests
{
    private const string Money = "src/Sample.Core/Pricing/Money.cs";
    private const string Loyalty = "src/Sample.Core/Loyalty/LoyaltyService.cs";
    private const string Catalog = "src/Sample.Core/Catalog/ProductCatalog.cs";
    private const string TaxRates = "src/Sample.Core/Pricing/TaxRates.cs";
    private const string CoreProject = "src/Sample.Core/Sample.Core.csproj";
    private const string Formatter = "src/Sample.Core/Customers/CustomerFormatter.cs";
    private const string FormatterTests = "tests/Sample.Tests.NUnit/CustomerFormatterTests.cs";
    private const string NewTestFile = "tests/Sample.Tests.NUnit/MoneyNUnitTests.cs";

    private static readonly string[] AllTestProjects = { "Sample.Tests.MSTest", "Sample.Tests.NUnit", "Sample.Tests.XUnit", "Sample.Tests.XUnitV3" };

    [Fact]
    public async Task Serve_KeepsTheWorkspaceWarm_AndAnswersEveryRequestKind()
    {
        using var copy = SampleCopy.Create("srv");
        await using var server = ServerProcess.Start(copy.SolutionDirectory, "--solution", copy.SolutionPath);

        // Requests before initialize are rejected.
        AssertError(await server.RequestAsync("impact", new { files = new[] { copy.PathOf(Money) } }), -32002);

        var init = await server.CallAsync("initialize", new { logLevel = "info" });
        Assert.Equal(1, init.GetProperty("protocolVersion").GetInt32());
        Assert.Equal(1, init.GetProperty("schemaVersion").GetInt32());
        Assert.Equal(PathUtil.Normalize(copy.RepositoryRoot), init.GetProperty("repositoryRoot").GetString());
        Assert.Equal(6, init.GetProperty("workspace").GetProperty("projects").GetInt32());
        Assert.Equal(AllTestProjects, init.GetProperty("workspace").GetProperty("testProjects").EnumerateArray().Select(p => p.GetProperty("name").GetString()).OrderBy(n => n, StringComparer.Ordinal));
        Assert.True(init.GetProperty("capabilities").GetProperty("impactSinceBase").GetBoolean());
        Assert.Equal(500, init.GetProperty("options").GetProperty("maxSymbols").GetInt32());

        // 1. Cancellation and supersede. The burst arrives while the warm-up holds the workspace: A is cancelled
        //    explicitly, B is superseded by C, and C (no files of its own) still covers A's and B's files.
        Edit(copy, Money, "throw new InvalidOperationException(\"Currencies must match.\");", "throw new InvalidOperationException($\"Currencies must match: {left.Currency} vs {right.Currency}.\");");
        Edit(copy, Loyalty, "RedeemThreshold = 100;", "RedeemThreshold = 150;");
        var a = server.NextRequestLine("impact", new { files = new[] { copy.PathOf(Money) } }, out var aId);
        var b = server.NextRequestLine("impact", new { files = new[] { copy.PathOf(Loyalty) } }, out var bId);
        var c = server.NextRequestLine("impact", new { files = Array.Empty<string>() }, out var cId);
        server.SendBurst(a, ServerProcess.NotificationLine("$/cancelRequest", new { id = int.Parse(aId) }), b, c);
        AssertCancelled(await server.ResponseAsync(aId), "cancelled");
        var superseded = await server.ResponseAsync(bId);
        AssertCancelled(superseded, "superseded");
        Assert.Equal(int.Parse(cId), superseded.GetProperty("error").GetProperty("data").GetProperty("by").GetInt32());
        var covered = Result(await server.ResponseAsync(cId));
        AssertTests(covered,
            XUnit + "MoneyTests.Add_SameCurrency_SumsAmounts",
            XUnitV3 + "MoneyV3Tests.Add_ReturnsSum",
            XUnitV3 + "MoneyV3Tests.Add_IsCommutative",
            MSTest + "LoyaltyServiceTests.CanRedeem_RespectsThreshold",
            MSTest + "LoyaltyServiceTests.Reset_ClearsPoints");
        Assert.Equal(new[] { copy.GitPathOf(Loyalty), copy.GitPathOf(Money) }, ChangedPaths(covered));

        // 2. A saved edit selects the tests that reach the changed method.
        Edit(copy, Catalog, "_prices.TryGetValue(sku, out var price)", "_prices.TryGetValue(sku.Trim(), out var price)");
        var catalogId = server.Send("impact", new { files = new[] { copy.PathOf(Catalog) } });
        var first = Result(await server.ResponseAsync(catalogId));
        AssertTests(first,
            XUnit + "CatalogTests.Default_ContainsBook",
            XUnit + "CatalogImportTests.Import_ParsesPrices",
            XUnitV3 + "CatalogV3Tests.PriceOf_Book");
        Assert.False(first.TryGetProperty("base", out _));
        Assert.Equal(JsonValueKind.Null, first.GetProperty("fallback").ValueKind);
        var file = Assert.Single(first.GetProperty("changedFiles").EnumerateArray());
        Assert.Equal("modified", file.GetProperty("status").GetString());
        Assert.Equal("selective", file.GetProperty("analysis").GetString());
        foreach (var phase in new[] { "queue", "workspaceUpdate", "compilation", "referenceSearch", "engineTotal", "total" })
        {
            Assert.True(first.GetProperty("durationsMs").TryGetProperty(phase, out _), $"missing duration '{phase}'");
        }

        Assert.Contains(server.Notifications, n => Method(n) == "progress" && n.GetProperty("params").TryGetProperty("id", out var pid) && pid.GetRawText() == catalogId && n.GetProperty("params").GetProperty("phase").GetString() == "search");

        // 3. A second edit of the same file reports only the new delta: the snapshot advanced.
        Edit(copy, Catalog, "catalog.Add(\"MUG\", 8.00m);", "catalog.Add(\"MUG\", 8.50m);");
        var second = await CallImpactAsync(server, copy, Catalog);
        AssertTests(second,
            XUnit + "CatalogTests.Default_ContainsBook",
            XUnit + "CatalogTests.Default_HasThreeProducts",
            XUnitV3 + "CatalogV3Tests.PriceOf_Book",
            XUnitV3 + "CatalogCountV3Tests.Count_IsThree");
        Assert.Equal("Sample.Core.Catalog.ProductCatalog.CreateDefault()", Assert.Single(second.GetProperty("changedSymbols").EnumerateArray()).GetProperty("symbol").GetString());

        // 4. A comment-only edit selects nothing; saving again without a change reports no changed file.
        Edit(copy, Catalog, "        return _prices.TryGetValue(sku.Trim(), out var price)", "        // Unknown SKUs throw.\n        return _prices.TryGetValue(sku.Trim(), out var price)");
        var comment = await CallImpactAsync(server, copy, Catalog);
        AssertTests(comment);
        Assert.Empty(comment.GetProperty("changedSymbols").EnumerateArray());
        Assert.Equal("selective", Assert.Single(comment.GetProperty("changedFiles").EnumerateArray()).GetProperty("analysis").GetString());
        var unchanged = await CallImpactAsync(server, copy, Catalog);
        Assert.Empty(unchanged.GetProperty("changedFiles").EnumerateArray());

        // 5. A new file is added to the project that owns its folder.
        File.WriteAllText(copy.PathOf(NewTestFile), """
            using Sample.Core.Pricing;

            namespace Sample.Tests.NUnit;

            public class MoneyNUnitTests
            {
                [Test]
                public void ToString_FormatsAmount() => Assert.That(new Money(1.5m, "EUR").ToString(), Is.EqualTo("1.50 EUR"));
            }
            """);
        var added = await CallImpactAsync(server, copy, NewTestFile);
        AssertTests(added, NUnit + "MoneyNUnitTests.ToString_FormatsAmount");
        Assert.Equal("added", Assert.Single(added.GetProperty("changedFiles").EnumerateArray()).GetProperty("status").GetString());

        // 6. A deleted file is analyzed in the old snapshot; its updated caller is selected.
        File.Delete(copy.PathOf(Formatter));
        Edit(copy, FormatterTests, "Assert.That(CustomerFormatter.Describe(customer), Is.EqualTo(\"c-9 (NL): 0 points\"));", "Assert.That(customer.Id, Is.EqualTo(\"c-9\"));");
        Edit(copy, FormatterTests, "using Sample.Core.Customers;\n", string.Empty);
        var deleted = await CallImpactAsync(server, copy, Formatter, FormatterTests);
        AssertTests(deleted, NUnit + "CustomerFormatterTests.Describe_IncludesPoints");
        Assert.Contains(deleted.GetProperty("changedFiles").EnumerateArray(), f => f.GetProperty("status").GetString() == "deleted");

        // 7. A project file change falls back and reloads the workspace in the background. Requests keep being
        //    answered meanwhile; those that need the reloading projects fall back with reason workspaceReloading.
        Edit(copy, CoreProject, "</Project>", "  <!-- touched by the server test -->\n</Project>");
        var project = await CallImpactAsync(server, copy, CoreProject);
        AssertFallback(project, FallbackKinds.BuildFile, AllTestProjects);
        Edit(copy, TaxRates, "\"NL\" => 0.21m,", "\"NL\" => 0.21m,\n            \"FR\" => 0.20m,");
        var during = await CallImpactAsync(server, copy, TaxRates);
        AssertTests(during,
            XUnit + "TaxRatesTests.ForCountry_ReturnsRate",
            XUnit + "PriceCalculatorTests.Total_IncludesTax",
            XUnit + "OrderServiceTests.PlaceOrder_ReturnsTotalWithTax",
            XUnit + "OrderServiceTests.PlaceOrder_SavesOrder",
            XUnit + "OrderServiceTests.PlaceOrder_WithoutLines_Throws");
        var reloadedEarly = server.Notifications.Any(n => Method(n) == "workspaceReloaded");
        Assert.True(reloadedEarly || FallbackKinds_(during).Contains(FallbackKinds.WorkspaceReloading), "a request during the reload must fall back for the reloading projects");

        var reloaded = await server.WaitForNotificationAsync(n => Method(n) == "workspaceReloaded", TimeSpan.FromMinutes(2));
        var outcome = reloaded.GetProperty("params");
        Assert.True(outcome.GetProperty("success").GetBoolean(), outcome.ToString());
        Assert.Equal(2, outcome.GetProperty("workspace").GetProperty("generation").GetInt32());
        // Every change was analyzed and the new file was added where MSBuild puts it: nothing is pending.
        Assert.Empty(outcome.GetProperty("pendingFiles").EnumerateArray());

        Edit(copy, Loyalty, "RedeemThreshold = 150;", "RedeemThreshold = 175;");
        var after = await CallImpactAsync(server, copy, Loyalty);
        AssertTests(after, MSTest + "LoyaltyServiceTests.CanRedeem_RespectsThreshold", MSTest + "LoyaltyServiceTests.Reset_ClearsPoints");
        Assert.Equal(JsonValueKind.Null, after.GetProperty("fallback").ValueKind);

        // 8. Base mode matches the one-shot CLI on the same working tree.
        var since = await server.CallAsync("impactSinceBase", new { @base = "HEAD" });
        var cli = ProcessRunner.Run("dotnet", copy.SolutionDirectory, SamplePaths.AnalyzerAssembly, "impact", "--solution", copy.SolutionPath, "--base", "HEAD", "--json");
        Assert.True(cli.ExitCode == 0, cli.Error);
        using (var cliReport = JsonDocument.Parse(cli.Output))
        {
            AssertSameReport(cliReport.RootElement, since);
        }

        Assert.Equal("HEAD", since.GetProperty("mergeBaseOf").GetString());
        Assert.Equal(ProcessRunner.Git(copy.RepositoryRoot, "rev-parse", "HEAD").Output.Trim(), since.GetProperty("baseCommit").GetString());
        var oneFile = await server.CallAsync("impactSinceBase", new { @base = "HEAD", mergeBase = false, files = new[] { copy.PathOf(Loyalty) } });
        Assert.Equal(new[] { copy.GitPathOf(Loyalty) }, ChangedPaths(oneFile));
        Assert.False(oneFile.TryGetProperty("mergeBaseOf", out _));
        AssertError(await server.RequestAsync("impactSinceBase", new { @base = "no-such-branch" }), -32602);

        // 9. Malformed and unknown input is answered with an error and the server keeps running.
        server.SendRaw("this is not json\n");
        server.SendRaw("[1, 2]\n");
        server.Expect("\"m1\"");
        server.SendRaw("{\"jsonrpc\":\"2.0\",\"id\":\"m1\"}\n");
        AssertError(await server.ResponseAsync("\"m1\""), -32600);
        AssertError(await server.RequestAsync("noSuchMethod"), -32601);
        AssertError(await server.RequestAsync("impact", new { files = "not-an-array" }), -32602);
        server.Expect("\"crlf\"");
        server.SendRaw("{\"jsonrpc\":\"2.0\",\"id\":\"crlf\",\"method\":\"status\"}\r\n");
        var status = (await server.ResponseAsync("\"crlf\"")).GetProperty("result");
        Assert.Equal("ready", status.GetProperty("state").GetString());
        Assert.Empty(status.GetProperty("pendingFiles").EnumerateArray());
        Assert.Contains(server.NullIdResponses, r => r.GetProperty("error").GetProperty("code").GetInt32() == -32700);
        Assert.Contains(server.NullIdResponses, r => r.GetProperty("error").GetProperty("code").GetInt32() == -32600);

        // 10. Shutdown, then exit.
        var shutdown = await server.RequestAsync("shutdown");
        Assert.Equal(JsonValueKind.Null, shutdown.GetProperty("result").ValueKind);
        AssertError(await server.RequestAsync("status"), -32600);
        server.Notify("exit");
        Assert.Equal(0, await server.WaitForExitAsync(TimeSpan.FromSeconds(30)));

        // stdout carried protocol messages only; logs were mirrored as notifications and timings went to stderr.
        foreach (var line in server.StdoutLines)
        {
            using var document = JsonDocument.Parse(line);
            Assert.Equal("2.0", document.RootElement.GetProperty("jsonrpc").GetString());
        }

        Assert.Contains(server.Notifications, n => Method(n) == "log" && n.GetProperty("params").GetProperty("level").GetString() == "info");
        Assert.Contains("[aftershock] info: impact", server.Stderr);
        Assert.Contains("referenceSearch=", server.Stderr);
    }

    [Fact]
    public async Task Serve_WithoutGit_RejectsBaseMode_AndExitsOnEndOfInput()
    {
        var directory = Path.Combine(Path.GetTempPath(), "aftershock-tests", "srv-nogit-" + Guid.NewGuid().ToString("N")[..8]);
        Directory.CreateDirectory(directory);
        try
        {
            var solution = Path.Combine(directory, "Empty.sln");
            File.WriteAllText(solution, "Microsoft Visual Studio Solution File, Format Version 12.00\n");
            await using var server = ServerProcess.Start(directory, "--solution", solution, "--max-symbols", "42");

            var init = await server.CallAsync("initialize");
            Assert.Equal(JsonValueKind.Null, init.GetProperty("repositoryRoot").ValueKind);
            Assert.False(init.GetProperty("capabilities").GetProperty("impactSinceBase").GetBoolean());
            Assert.Equal(42, init.GetProperty("options").GetProperty("maxSymbols").GetInt32());
            AssertError(await server.RequestAsync("impactSinceBase", new { @base = "HEAD" }), -32600);
            AssertError(await server.RequestAsync("initialize"), -32600);

            server.CloseInput();
            Assert.Equal(0, await server.WaitForExitAsync(TimeSpan.FromSeconds(30)));
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    [Fact]
    public void Serve_UsageErrors_ExitWithCode2()
    {
        var missing = ProcessRunner.Run("dotnet", Path.GetTempPath(), SamplePaths.AnalyzerAssembly, "serve", "--solution", Path.Combine(Path.GetTempPath(), "no-such-" + Guid.NewGuid().ToString("N")[..8] + ".sln"));
        Assert.Equal(2, missing.ExitCode);
        Assert.Equal(string.Empty, missing.Output);

        var noSolution = ProcessRunner.Run("dotnet", Path.GetTempPath(), SamplePaths.AnalyzerAssembly, "serve");
        Assert.Equal(2, noSolution.ExitCode);
    }

    private static async Task<JsonElement> CallImpactAsync(ServerProcess server, SampleCopy copy, params string[] relativePaths) =>
        await server.CallAsync("impact", new { files = relativePaths.Select(copy.PathOf).ToArray() });

    private static JsonElement Result(JsonElement response)
    {
        Assert.True(response.TryGetProperty("result", out var result), "expected a result: " + response);
        return result;
    }

    private static string? Method(JsonElement message) => message.TryGetProperty("method", out var method) ? method.GetString() : null;

    private static void Edit(SampleCopy copy, string relativePath, string oldText, string newText)
    {
        var path = copy.PathOf(relativePath);
        var text = File.ReadAllText(path);
        Assert.Contains(oldText, text);
        File.WriteAllText(path, text.Replace(oldText, newText, StringComparison.Ordinal));
    }

    private static void AssertError(JsonElement response, int code)
    {
        Assert.True(response.TryGetProperty("error", out var error), $"expected error {code}, got {response}");
        Assert.Equal(code, error.GetProperty("code").GetInt32());
    }

    private static void AssertCancelled(JsonElement response, string reason)
    {
        AssertError(response, -32800);
        Assert.Equal(reason, response.GetProperty("error").GetProperty("data").GetProperty("reason").GetString());
    }

    private static void AssertTests(JsonElement report, params string[] expected)
    {
        var actual = TestNames(report);
        Assert.True(
            actual.SequenceEqual(expected.OrderBy(n => n, StringComparer.Ordinal)),
            $"selected tests differ.\nExpected: {string.Join(", ", expected.OrderBy(n => n, StringComparer.Ordinal))}\nActual:   {string.Join(", ", actual)}\nReport: {report}");
    }

    private static List<string> TestNames(JsonElement report) =>
        report.GetProperty("tests").EnumerateArray().Select(t => t.GetProperty("fullyQualifiedName").GetString()!).OrderBy(n => n, StringComparer.Ordinal).ToList();

    private static List<string> ChangedPaths(JsonElement report) =>
        report.GetProperty("changedFiles").EnumerateArray().Select(f => f.GetProperty("path").GetString()!).OrderBy(p => p, StringComparer.Ordinal).ToList();

    private static List<string> FallbackKinds_(JsonElement report) =>
        report.GetProperty("fallback").ValueKind == JsonValueKind.Null
            ? new List<string>()
            : report.GetProperty("fallback").GetProperty("reasons").EnumerateArray().Select(r => r.GetProperty("kind").GetString()!).ToList();

    private static void AssertFallback(JsonElement report, string kind, params string[] testProjectNames)
    {
        Assert.Contains(kind, FallbackKinds_(report));
        var projects = report.GetProperty("fallback").GetProperty("testProjects").EnumerateArray().Select(p => Path.GetFileNameWithoutExtension(p.GetString())!).OrderBy(n => n, StringComparer.Ordinal);
        Assert.Equal(testProjectNames, projects);
    }

    /// <summary>The parts of the report that do not depend on timing: files, symbols, tests and fallbacks.</summary>
    private static void AssertSameReport(JsonElement expected, JsonElement actual)
    {
        static IEnumerable<string> Files(JsonElement r) => r.GetProperty("changedFiles").EnumerateArray()
            .Select(f => $"{f.GetProperty("path").GetString()}|{f.GetProperty("status").GetString()}|{f.GetProperty("analysis").GetString()}").OrderBy(s => s, StringComparer.Ordinal);
        static IEnumerable<string> Symbols(JsonElement r) => r.GetProperty("changedSymbols").EnumerateArray()
            .Select(s => $"{s.GetProperty("symbol").GetString()}|{s.GetProperty("reason").GetString()}").OrderBy(s => s, StringComparer.Ordinal);
        static IEnumerable<string> Tests(JsonElement r) => r.GetProperty("tests").EnumerateArray()
            .Select(t => $"{t.GetProperty("fullyQualifiedName").GetString()}|{t.GetProperty("reason").GetString()}|{t.GetProperty("project").GetString()}").OrderBy(s => s, StringComparer.Ordinal);
        static IEnumerable<string> Fallbacks(JsonElement r) => r.GetProperty("fallback").ValueKind == JsonValueKind.Null
            ? Enumerable.Empty<string>()
            : r.GetProperty("fallback").GetProperty("reasons").EnumerateArray()
                .Select(f => $"{f.GetProperty("kind").GetString()}|{string.Join(",", f.GetProperty("testProjects").EnumerateArray().Select(p => p.GetString()))}").OrderBy(s => s, StringComparer.Ordinal);
        static IEnumerable<string> Projects(JsonElement r) => r.GetProperty("testProjects").EnumerateArray()
            .Select(p => $"{p.GetProperty("path").GetString()}|{p.GetProperty("mode").GetString()}|{p.GetProperty("tests").GetInt32()}").OrderBy(s => s, StringComparer.Ordinal);

        Assert.Equal(Files(expected), Files(actual));
        Assert.Equal(Symbols(expected), Symbols(actual));
        Assert.Equal(Tests(expected), Tests(actual));
        Assert.Equal(Fallbacks(expected), Fallbacks(actual));
        Assert.Equal(Projects(expected), Projects(actual));
        Assert.Equal(expected.GetProperty("baseCommit").GetString(), actual.GetProperty("baseCommit").GetString());
        Assert.Equal(expected.GetProperty("solution").GetString(), actual.GetProperty("solution").GetString());
        Assert.Equal(expected.GetProperty("repositoryRoot").GetString(), actual.GetProperty("repositoryRoot").GetString());
    }
}
