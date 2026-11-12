using Aftershock.Analyzer.Engine;
using Aftershock.Analyzer.Output;

namespace Aftershock.Analyzer.Tests.Infrastructure;

internal static class Expect
{
    public const string XUnit = "Sample.Tests.XUnit.";
    public const string XUnitV3 = "Sample.Tests.XUnitV3.";
    public const string NUnit = "Sample.Tests.NUnit.";
    public const string MSTest = "Sample.Tests.MSTest.";

    /// <summary>Asserts the exact set of selected tests (no missing, no extra).</summary>
    public static void Selected(ImpactResult result, params string[] expected)
    {
        var actual = result.Tests.Select(t => t.FullyQualifiedName).OrderBy(n => n, StringComparer.Ordinal).ToList();
        var wanted = expected.OrderBy(n => n, StringComparer.Ordinal).ToList();
        var missing = wanted.Except(actual).ToList();
        var extra = actual.Except(wanted).ToList();
        if (missing.Count > 0 || extra.Count > 0 || actual.Count != wanted.Count)
        {
            var details = string.Join(Environment.NewLine, result.Tests.Select(t => $"  {t.FullyQualifiedName}: {string.Join(" <- ", t.Chain)}"));
            var symbols = string.Join(Environment.NewLine, result.ChangedSymbols.Select(s => $"  {s.Symbol} ({s.Kind}, {s.Reason})"));
            Assert.Fail($"Selected tests differ.{Environment.NewLine}Missing: {string.Join(", ", missing)}{Environment.NewLine}Extra: {string.Join(", ", extra)}{Environment.NewLine}Selected:{Environment.NewLine}{details}{Environment.NewLine}Changed symbols:{Environment.NewLine}{symbols}{Environment.NewLine}Fallback: {Describe(result.Fallback)}");
        }
    }

    public static TestReport Test(ImpactResult result, string fullyQualifiedName)
    {
        var test = result.Tests.SingleOrDefault(t => t.FullyQualifiedName == fullyQualifiedName);
        Assert.True(test is not null, $"{fullyQualifiedName} was not selected");
        return test!;
    }

    public static void NoFallback(ImpactResult result)
    {
        Assert.True(result.Fallback is null, "unexpected fallback: " + Describe(result.Fallback));
    }

    /// <summary>Asserts one fallback reason of the given kind and the exact set of whole test projects (by project name).</summary>
    public static void Fallback(ImpactResult result, string kind, params string[] testProjectNames)
    {
        Assert.True(result.Fallback is not null, "expected a fallback");
        Assert.Contains(result.Fallback!.Reasons, r => r.Kind == kind);
        var actual = result.Fallback.TestProjects.Select(p => Path.GetFileNameWithoutExtension(p)!).OrderBy(n => n, StringComparer.Ordinal).ToList();
        Assert.Equal(testProjectNames.OrderBy(n => n, StringComparer.Ordinal).ToList(), actual);
        foreach (var name in testProjectNames)
        {
            Assert.Contains(result.TestProjects, p => p.Name == name && p.Mode == "all");
        }
    }

    private static string Describe(FallbackReport? fallback) =>
        fallback is null ? "none" : string.Join("; ", fallback.Reasons.Select(r => $"[{r.Kind}] {r.Message} -> {string.Join(",", r.TestProjects.Select(Path.GetFileNameWithoutExtension))}"));
}
