using System.Text.Json;
using Aftershock.Analyzer.Cli;
using Aftershock.Analyzer.Output;
using Aftershock.Analyzer.Tests.Infrastructure;

namespace Aftershock.Analyzer.Tests;

/// <summary>
/// The real pipeline: git (working tree vs base commit, untracked files, deletions, renames) → MSBuildWorkspace →
/// engine → JSON. The sample lives in repo/samples/ImpactSample, so the solution is not at the git root.
/// </summary>
public sealed class CliEndToEndTests
{
    [Fact]
    public async Task Impact_ReportsGitChangesOfEveryKind()
    {
        using var copy = SampleCopy.Create("cli");
        // Modified (unstaged).
        Edit(copy, "src/Sample.Core/Pricing/TaxRates.cs", "\"NL\" => 0.21m,", "\"NL\" => 0.21m,\n            \"FR\" => 0.20m,");
        // Modified (staged).
        Edit(copy, "src/Sample.Core/Loyalty/LoyaltyService.cs", "return customer.LoyaltyPoints >= RedeemThreshold;", "return customer.LoyaltyPoints >= RedeemThreshold && customer.Id.Length > 0;");
        ProcessRunner.Git(copy.RepositoryRoot, "add", copy.GitPathOf("src/Sample.Core/Loyalty/LoyaltyService.cs"));
        // Untracked new files.
        File.WriteAllText(copy.PathOf("tests/Sample.Tests.NUnit/MoneyNUnitTests.cs"), """
            using Sample.Core.Pricing;

            namespace Sample.Tests.NUnit;

            public class MoneyNUnitTests
            {
                [Test]
                public void ToString_FormatsAmount() => Assert.That(new Money(1.5m, "EUR").ToString(), Is.EqualTo("1.50 EUR"));
            }
            """);
        // Deleted files (unstaged deletion).
        File.Delete(copy.PathOf("src/Sample.Core/Customers/CustomerFormatter.cs"));
        File.Delete(copy.PathOf("tests/Sample.Tests.NUnit/CustomerFormatterTests.cs"));
        // Renamed file (staged with git mv, content unchanged).
        ProcessRunner.Git(copy.RepositoryRoot, "mv", copy.GitPathOf("src/Sample.Core/Reporting/SalesReport.cs"), copy.GitPathOf("src/Sample.Core/Reporting/SalesSummary.cs"));
        // Fallback glob.
        Edit(copy, "src/Sample.Web/appsettings.json", "\"Currency\": \"EUR\"", "\"Currency\": \"USD\"");

        var (exitCode, stdout, stderr) = await RunInProcessAsync("impact", "--solution", copy.SolutionPath, "--base", "HEAD", "--json");

        Assert.True(exitCode == 0, stderr);
        var report = JsonSerializer.Deserialize<ImpactReport>(stdout, ReportJson.Options)!;
        Assert.Equal(1, report.SchemaVersion);
        Assert.Equal(ProcessRunner.Git(copy.RepositoryRoot, "rev-parse", "HEAD").Output.Trim(), report.BaseCommit);
        Assert.Equal("HEAD", report.Base);
        Assert.Equal(Aftershock.Analyzer.Engine.PathUtil.Normalize(copy.RepositoryRoot), report.RepositoryRoot);

        var files = report.ChangedFiles.ToDictionary(f => f.Path);
        Assert.Equal("modified", files[copy.GitPathOf("src/Sample.Core/Pricing/TaxRates.cs")].Status);
        Assert.Equal("modified", files[copy.GitPathOf("src/Sample.Core/Loyalty/LoyaltyService.cs")].Status);
        Assert.Equal("untracked", files[copy.GitPathOf("tests/Sample.Tests.NUnit/MoneyNUnitTests.cs")].Status);
        Assert.Equal("deleted", files[copy.GitPathOf("src/Sample.Core/Customers/CustomerFormatter.cs")].Status);
        Assert.Equal("deleted", files[copy.GitPathOf("tests/Sample.Tests.NUnit/CustomerFormatterTests.cs")].Status);
        var renamed = files[copy.GitPathOf("src/Sample.Core/Reporting/SalesSummary.cs")];
        Assert.Equal("renamed", renamed.Status);
        Assert.Equal(copy.GitPathOf("src/Sample.Core/Reporting/SalesReport.cs"), renamed.OldPath);
        Assert.Equal("fallback", files[copy.GitPathOf("src/Sample.Web/appsettings.json")].Analysis);
        Assert.Equal(7, report.ChangedFiles.Count);

        var tests = report.Tests.Select(t => t.FullyQualifiedName).OrderBy(n => n, StringComparer.Ordinal).ToList();
        Assert.Equal(
            new[]
            {
                "Sample.Tests.MSTest.LoyaltyServiceTests.CanRedeem_RespectsThreshold",
                "Sample.Tests.NUnit.MoneyNUnitTests.ToString_FormatsAmount",
                "Sample.Tests.XUnit.OrderServiceTests.PlaceOrder_ReturnsTotalWithTax",
                "Sample.Tests.XUnit.OrderServiceTests.PlaceOrder_SavesOrder",
                "Sample.Tests.XUnit.OrderServiceTests.PlaceOrder_WithoutLines_Throws",
                "Sample.Tests.XUnit.PriceCalculatorTests.Total_IncludesTax",
                "Sample.Tests.XUnit.TaxRatesTests.ForCountry_ReturnsRate",
            },
            tests);

        Assert.NotNull(report.Fallback);
        var reason = Assert.Single(report.Fallback!.Reasons);
        Assert.Equal("fallbackGlob", reason.Kind);
        Assert.EndsWith("Sample.Tests.XUnit.csproj", Assert.Single(report.Fallback.TestProjects));

        var projects = report.TestProjects.ToDictionary(p => p.Name);
        Assert.Equal("all", projects["Sample.Tests.XUnit"].Mode);
        Assert.Equal("filter", projects["Sample.Tests.NUnit"].Mode);
        Assert.Equal("filter", projects["Sample.Tests.MSTest"].Mode);
        Assert.Equal(3, projects.Count);

        foreach (var key in new[] { "git", "workspaceLoad", "diff", "memberMapping", "compilation", "referenceSearch", "total" })
        {
            Assert.True(report.DurationsMs.ContainsKey(key), $"missing duration '{key}'");
        }

        Assert.DoesNotContain(report.Diagnostics, d => d.Severity == "error");
        Assert.Contains("[aftershock]", stderr);
    }

    [Fact]
    public void Process_WritesOnlyJsonToStdout_AndLogsToStderr()
    {
        using var copy = SampleCopy.Create("proc");
        Edit(copy, "src/Sample.Core/Pricing/Money.cs", "public override string ToString() => $\"{Amount:0.00} {Currency}\";", "public override string ToString() => $\"{Amount:0.00} {Currency}\".Trim();");
        File.WriteAllText(copy.PathOf("NOTES.md"), "release notes draft\n");

        var json = ProcessRunner.Run("dotnet", copy.SolutionDirectory, SamplePaths.AnalyzerAssembly, "impact", "--solution", copy.SolutionPath, "--base", "HEAD", "--json");
        Assert.True(json.ExitCode == 0, json.Error);
        using var document = JsonDocument.Parse(json.Output);
        Assert.Equal(1, document.RootElement.GetProperty("schemaVersion").GetInt32());
        Assert.Equal(JsonValueKind.Null, document.RootElement.GetProperty("fallback").ValueKind);
        Assert.Equal(0, document.RootElement.GetProperty("tests").GetArrayLength());
        Assert.Contains("[aftershock] info", json.Error);

        var text = ProcessRunner.Run("dotnet", copy.SolutionDirectory, SamplePaths.AnalyzerAssembly, "impact", "--solution", "ImpactSample.sln", "--base", "HEAD");
        Assert.True(text.ExitCode == 0, text.Error);
        Assert.Contains("Impacted tests (0)", text.Output);
        Assert.Contains("+ 1 ignored file(s)", text.Output);
        Assert.DoesNotContain("NOTES.md", text.Output);
        Assert.Contains("\"analysis\": \"ignored\"", json.Output);
        Assert.Contains("Sample.Core.Pricing.Money.ToString()", text.Output);

        var usage = ProcessRunner.Run("dotnet", copy.SolutionDirectory, SamplePaths.AnalyzerAssembly, "impact", "--solution", copy.SolutionPath);
        Assert.Equal(2, usage.ExitCode);
        Assert.Equal(string.Empty, usage.Output);

        var badRef = ProcessRunner.Run("dotnet", copy.SolutionDirectory, SamplePaths.AnalyzerAssembly, "impact", "--solution", copy.SolutionPath, "--base", "no-such-branch");
        Assert.Equal(2, badRef.ExitCode);
        Assert.Contains("no-such-branch", badRef.Error);
    }

    [Fact]
    public async Task OutsideGit_IsFatal_AndMissingSolution_IsUsageError()
    {
        var directory = Path.Combine(Path.GetTempPath(), "aftershock-tests", "nogit-" + Guid.NewGuid().ToString("N")[..8]);
        Directory.CreateDirectory(directory);
        try
        {
            var solution = Path.Combine(directory, "Empty.sln");
            File.WriteAllText(solution, "Microsoft Visual Studio Solution File, Format Version 12.00\n");
            var outsideGit = await RunInProcessAsync("impact", "--solution", solution, "--base", "HEAD");
            Assert.Equal(1, outsideGit.ExitCode);
            Assert.Contains("not inside a git work tree", outsideGit.Stderr);

            var missing = await RunInProcessAsync("impact", "--solution", Path.Combine(directory, "Missing.sln"), "--base", "HEAD");
            Assert.Equal(2, missing.ExitCode);
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    private static void Edit(SampleCopy copy, string relativePath, string oldText, string newText)
    {
        var path = copy.PathOf(relativePath);
        var text = File.ReadAllText(path);
        Assert.Contains(oldText, text);
        File.WriteAllText(path, text.Replace(oldText, newText, StringComparison.Ordinal));
    }

    private static async Task<(int ExitCode, string Stdout, string Stderr)> RunInProcessAsync(params string[] args)
    {
        var parse = CliOptions.Parse(args);
        if (parse.Options is null)
        {
            return (parse.ExitCode ?? 2, string.Empty, parse.Message ?? string.Empty);
        }

        using var stdout = new StringWriter();
        using var stderr = new StringWriter();
        var exitCode = await ImpactCommand.RunAsync(parse.Options, stdout, stderr);
        return (exitCode, stdout.ToString(), stderr.ToString());
    }
}
