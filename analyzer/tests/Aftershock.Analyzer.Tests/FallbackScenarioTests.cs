using Aftershock.Analyzer.Engine;
using Aftershock.Analyzer.Tests.Infrastructure;
using static Aftershock.Analyzer.Tests.Infrastructure.Expect;

namespace Aftershock.Analyzer.Tests;

/// <summary>Safety net: changes that static member analysis cannot judge run whole dependent test projects.</summary>
[Collection(SampleWorkspaceCollection.Name)]
public sealed class FallbackScenarioTests
{
    private static readonly string[] AllTestProjects = { "Sample.Tests.MSTest", "Sample.Tests.NUnit", "Sample.Tests.XUnit", "Sample.Tests.XUnitV3" };

    private readonly SampleWorkspaceFixture _fixture;

    public FallbackScenarioTests(SampleWorkspaceFixture fixture)
    {
        _fixture = fixture;
    }

    [Fact]
    public async Task LibraryProjectFile_RunsEveryDependentTestProject()
    {
        var result = await _fixture.Change().Touch("src/Sample.Core/Sample.Core.csproj").AnalyzeAsync();

        Fallback(result, FallbackKinds.BuildFile, AllTestProjects);
        Selected(result);
        Assert.Equal("fallback", Assert.Single(result.ChangedFiles).Analysis);
    }

    [Fact]
    public async Task TestProjectFile_RunsOnlyThatTestProject()
    {
        var result = await _fixture.Change().Touch("tests/Sample.Tests.NUnit/Sample.Tests.NUnit.csproj").AnalyzeAsync();

        Fallback(result, FallbackKinds.BuildFile, "Sample.Tests.NUnit");
    }

    [Fact]
    public async Task DirectoryBuildProps_AppliesToProjectsBelowIt()
    {
        var result = await _fixture.Change().Touch("Directory.Build.props").AnalyzeAsync();

        Fallback(result, FallbackKinds.BuildFile, AllTestProjects);
    }

    [Fact]
    public async Task DirectoryBuildPropsInSubfolder_IsScopedToThatFolder()
    {
        var result = await _fixture.Change().Touch("tests/Directory.Build.props", FileChangeKind.Added).AnalyzeAsync();

        Fallback(result, FallbackKinds.BuildFile, AllTestProjects);

        var sourceOnly = await _fixture.Change().Touch("src/Sample.Web/Directory.Packages.props", FileChangeKind.Added).AnalyzeAsync();
        Fallback(sourceOnly, FallbackKinds.BuildFile, "Sample.Tests.XUnit");
    }

    [Fact]
    public async Task GlobalJsonAndNuGetConfig_RunEverythingBelowThem()
    {
        var result = await _fixture.Change()
            .Touch("global.json", FileChangeKind.Added)
            .Touch("NuGet.Config", FileChangeKind.Added)
            .AnalyzeAsync();

        Fallback(result, FallbackKinds.BuildFile, AllTestProjects);
        Assert.Equal(2, result.Fallback!.Reasons.Count);
    }

    [Fact]
    public async Task AppSettings_RunsOwningProjectDependents()
    {
        var result = await _fixture.Change()
            .Touch("src/Sample.Web/appsettings.json")
            .Touch("src/Sample.Web/appsettings.Development.json")
            .AnalyzeAsync();

        Fallback(result, FallbackKinds.FallbackGlob, "Sample.Tests.XUnit");
        Assert.All(result.Fallback!.Reasons, r => Assert.Contains("**/appsettings*.json", r.Message));
    }

    [Fact]
    public async Task CustomFallbackGlob_ReplacesTheDefault()
    {
        var options = new ImpactOptions { FallbackGlobs = new[] { "**/*.sql" }, Timeout = TimeSpan.FromMinutes(2) };
        var appsettings = await _fixture.Change().Touch("src/Sample.Web/appsettings.json").AnalyzeAsync(options);
        NoFallback(appsettings);
        Assert.Equal("ignored", Assert.Single(appsettings.ChangedFiles).Analysis);

        var sql = await _fixture.Change().Touch("src/Sample.Core/Scripts/seed.sql", FileChangeKind.Added).AnalyzeAsync(options);
        Fallback(sql, FallbackKinds.FallbackGlob, AllTestProjects);
    }

    [Fact]
    public async Task DependencyInjectionRegistration_RunsDependents()
    {
        var result = await _fixture.Change()
            .Replace("src/Sample.Web/ServiceCollectionExtensions.cs", "services.AddSingleton<SalesReport>();", "services.AddScoped<SalesReport>();")
            .AnalyzeAsync();

        Fallback(result, FallbackKinds.DiRegistration, "Sample.Tests.XUnit");
        Selected(result);
    }

    [Fact]
    public async Task ProgramCs_RunsDependents()
    {
        var result = await _fixture.Change()
            .Replace("src/Sample.Web/Program.cs", "app.MapGet(\"/health\", () => \"ok\");", "app.MapGet(\"/health\", () => \"healthy\");")
            .AnalyzeAsync();

        Fallback(result, FallbackKinds.EntryPoint, "Sample.Tests.XUnit");
    }

    [Fact]
    public async Task BfsLimit_FallsBackForTheFile()
    {
        var options = new ImpactOptions { MaxSymbols = 2, Timeout = TimeSpan.FromMinutes(2) };
        var result = await _fixture.Change()
            .Replace("src/Sample.Core/Pricing/TaxRates.cs", "\"NL\" => 0.21m,", "\"NL\" => 0.215m,")
            .AnalyzeAsync(options);

        Fallback(result, FallbackKinds.BfsLimit, AllTestProjects);
        Selected(result);
        Assert.Equal("fallback", Assert.Single(result.ChangedFiles).Analysis);
    }

    [Fact]
    public async Task Timeout_FallsBackForTheFile()
    {
        var options = new ImpactOptions { Timeout = TimeSpan.FromMilliseconds(1) };
        var result = await _fixture.Change()
            .Replace("src/Sample.Core/Pricing/TaxRates.cs", "\"NL\" => 0.21m,", "\"NL\" => 0.215m,")
            .AnalyzeAsync(options);

        Fallback(result, FallbackKinds.Timeout, AllTestProjects);
        Selected(result);
    }

    [Fact]
    public async Task FileOutsideTheWorkspace_FallsBackForItsOwningProject()
    {
        var result = await _fixture.Change()
            .Touch("src/Sample.Core/Excluded/Extra.cs", FileChangeKind.Added, "namespace Sample.Core.Excluded; public class Extra { }")
            .AnalyzeAsync();

        Fallback(result, FallbackKinds.NotInWorkspace, AllTestProjects);
    }

    [Fact]
    public async Task UnrelatedFiles_AreIgnored()
    {
        var result = await _fixture.Change()
            .Touch("README.md")
            .Touch("src/Sample.Core/obj/Sample.Core.csproj.nuget.g.props", FileChangeKind.Added)
            .Touch("tests/Sample.Tests.XUnit/bin/Debug/net8.0/appsettings.json", FileChangeKind.Added)
            .AnalyzeAsync();

        NoFallback(result);
        Selected(result);
        Assert.All(result.ChangedFiles, f => Assert.Equal("ignored", f.Analysis));
    }

    [Fact]
    public async Task FallbackAndSelectiveResults_Coexist()
    {
        var result = await _fixture.Change()
            .Touch("tests/Sample.Tests.NUnit/Sample.Tests.NUnit.csproj")
            .Replace("src/Sample.Core/Catalog/ProductCatalog.cs", "_prices.TryGetValue(sku, out var price)", "_prices.TryGetValue(sku.Trim(), out var price)")
            .AnalyzeAsync();

        Fallback(result, FallbackKinds.BuildFile, "Sample.Tests.NUnit");
        Selected(result,
            XUnit + "CatalogTests.Default_ContainsBook",
            XUnit + "CatalogImportTests.Import_ParsesPrices",
            XUnitV3 + "CatalogV3Tests.PriceOf_Book");

        var projects = result.TestProjects.ToDictionary(p => p.Name);
        Assert.Equal("all", projects["Sample.Tests.NUnit"].Mode);
        Assert.Equal("filter", projects["Sample.Tests.XUnit"].Mode);
        Assert.Equal(2, projects["Sample.Tests.XUnit"].Tests);
        Assert.Equal("filter", projects["Sample.Tests.XUnitV3"].Mode);
        Assert.Equal(new[] { "xunit" }, projects["Sample.Tests.XUnitV3"].Frameworks);
        Assert.Equal(3, result.TestProjects.Count);
    }
}
