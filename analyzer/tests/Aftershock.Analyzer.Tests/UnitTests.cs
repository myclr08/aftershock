using Aftershock.Analyzer.Cli;
using Aftershock.Analyzer.Engine;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.Text;

namespace Aftershock.Analyzer.Tests;

public sealed class LineDiffTests
{
    [Fact]
    public void IgnoresLineEndingDifferences()
    {
        var hunks = LineDiff.Compute(SourceText.From("a\r\nb\r\nc\r\n"), SourceText.From("a\nb\nc\n"));
        Assert.Empty(hunks);
    }

    [Fact]
    public void ReportsInsertedAndDeletedLines()
    {
        var hunks = LineDiff.Compute(SourceText.From("a\nb\nc\nd\n"), SourceText.From("a\nc\nX\nd\n"));
        Assert.Equal(2, hunks.Count);
        Assert.Equal(new DiffHunk(1, 1, 1, 0), hunks[0]);
        Assert.Equal(new DiffHunk(3, 0, 2, 1), hunks[1]);
    }
}

public sealed class GlobMatcherTests
{
    [Theory]
    [InlineData("**/appsettings*.json", "src/Web/appsettings.json", true)]
    [InlineData("**/appsettings*.json", "appsettings.Development.json", true)]
    [InlineData("**/appsettings*.json", "src/Web/settings.json", false)]
    [InlineData("appsettings*.json", "deep/folder/appsettings.Production.json", true)]
    [InlineData("config/*.yml", "config/app.yml", true)]
    [InlineData("config/*.yml", "config/nested/app.yml", false)]
    [InlineData("config/**/*.{yml,yaml}", "config/nested/app.yaml", true)]
    [InlineData("data/file?.csv", "data/file1.csv", true)]
    public void Matches(string pattern, string path, bool expected)
    {
        Assert.Equal(expected, new GlobMatcher(pattern).IsMatch(path));
    }
}

public sealed class CliOptionsTests
{
    [Fact]
    public void ParsesAllOptions()
    {
        var result = CliOptions.Parse(new[] { "impact", "--solution", "a.sln", "--base", "origin/main", "--json", "--max-symbols", "50", "--timeout-seconds=3", "--fallback-glob", "**/*.sql", "--fallback-glob", "**/appsettings*.json" });
        var options = Assert.IsType<ImpactCommandOptions>(result.Options);
        Assert.Equal("a.sln", options.Solution);
        Assert.Equal("origin/main", options.Base);
        Assert.True(options.Json);
        Assert.Equal(50, options.MaxSymbols);
        Assert.Equal(3, options.TimeoutSeconds);
        Assert.Equal(new[] { "**/*.sql", "**/appsettings*.json" }, options.FallbackGlobs);
    }

    [Fact]
    public void DefaultsMatchTheSpec()
    {
        var options = CliOptions.Parse(new[] { "impact", "--solution", "a.sln", "--base", "HEAD" }).Options!;
        Assert.Equal(500, options.MaxSymbols);
        Assert.Equal(10, options.TimeoutSeconds);
        Assert.Equal(new[] { "**/appsettings*.json" }, options.FallbackGlobs);
        Assert.False(options.Json);
    }

    public static TheoryData<string[]> UsageErrorArguments => new()
    {
        Array.Empty<string>(),
        new[] { "analyze" },
        new[] { "impact", "--base", "HEAD" },
        new[] { "impact", "--solution", "a.sln" },
        new[] { "impact", "--solution", "a.sln", "--base", "HEAD", "--max-symbols", "many" },
        new[] { "impact", "--solution", "a.sln", "--base", "HEAD", "--unknown" },
    };

    [Theory]
    [MemberData(nameof(UsageErrorArguments))]
    public void UsageErrors_ReturnExitCode2(string[] args)
    {
        var result = CliOptions.Parse(args);
        Assert.Null(result.Options);
        Assert.Equal(CliOptions.ExitUsage, result.ExitCode);
    }

    [Fact]
    public void Help_ReturnsExitCode0()
    {
        Assert.Equal(CliOptions.ExitSuccess, CliOptions.Parse(new[] { "--help" }).ExitCode);
    }
}

public sealed class ChangeMapperTests
{
    private static IReadOnlyList<PendingChange> Map(string oldCode, string newCode)
    {
        var oldText = SourceText.From(oldCode);
        var newText = SourceText.From(newCode);
        var oldRoot = CSharpSyntaxTree.ParseText(oldText).GetRoot();
        var newRoot = CSharpSyntaxTree.ParseText(newText).GetRoot();
        var id = DocumentId.CreateNewId(ProjectId.CreateNewId());
        return ChangeMapper.MapHunks(LineDiff.Compute(oldText, newText), oldRoot, oldText, id, newRoot, newText, id);
    }

    private const string Code = """
        using System;

        namespace N;

        public class C
        {
            private int _x = 1;

            public int P { get; set; }

            public int Q => _x * 2;

            public void M()
            {
                Func<int, int> f = v => v + 1;
                Local();

                void Local() => Console.WriteLine(f(_x));
            }

            public void Other()
            {
            }
        }
        """;

    [Fact]
    public void LambdaAndLocalFunctionMapToEnclosingMethod()
    {
        var changes = Map(Code, Code.Replace("v => v + 1", "v => v + 2").Replace("Console.WriteLine(f(_x))", "Console.Write(f(_x))"));
        var change = Assert.Single(changes);
        Assert.Equal(ChangeReason.Modified, change.Reason);
        Assert.Contains("void M()", change.Context!.Node.ToString());
    }

    [Fact]
    public void ExpressionBodiedPropertyMapsToGetter()
    {
        var change = Assert.Single(Map(Code, Code.Replace("_x * 2", "_x * 3")));
        Assert.Equal(ContextKind.ExpressionBodyGetter, change.Context!.Kind);
    }

    [Fact]
    public void AutoPropertyAccessorChangeMapsToAccessor()
    {
        var change = Assert.Single(Map(Code, Code.Replace("public int P { get; set; }", "public int P { get; private set; }")));
        Assert.Equal(ContextKind.Accessor, change.Context!.Kind);
    }

    [Fact]
    public void FieldChangeIsATypeLevelChange()
    {
        var change = Assert.Single(Map(Code, Code.Replace("_x = 1;", "_x = 2;")));
        Assert.NotNull(change.TypeNode);
        Assert.Equal(ChangeReason.TypeChanged, change.Reason);
        Assert.Contains("fields", change.Detail);
    }

    [Fact]
    public void AddedMemberIsAddedPlusTypeLevel()
    {
        var changes = Map(Code, Code.Replace("    public void Other()", "    public void Added()\n    {\n    }\n\n    public void Other()"));
        Assert.Contains(changes, c => c.Reason == ChangeReason.Added && c.Context is not null);
        Assert.Contains(changes, c => c.Reason == ChangeReason.TypeChanged && c.TypeNode is not null && c.MemberAddedOnly);
        Assert.Equal(2, changes.Count);
    }

    [Fact]
    public void AddedMemberPlusFieldChangeIsAFullTypeLevelChange()
    {
        var changes = Map(Code, Code.Replace("_x = 1;", "_x = 2;").Replace("    public void Other()", "    public void Added()\n    {\n    }\n\n    public void Other()"));
        var typeChange = Assert.Single(changes, c => c.TypeNode is not null);
        Assert.False(typeChange.MemberAddedOnly);
        Assert.Contains("fields", typeChange.Detail);
    }

    [Fact]
    public void RemovedMemberIsDeletedInOldSnapshot()
    {
        var change = Assert.Single(Map(Code, Code.Replace("    public void Other()\n    {\n    }\n", string.Empty)));
        Assert.Equal(ChangeReason.Deleted, change.Reason);
        Assert.True(change.InOld);
    }

    [Fact]
    public void WhitespaceCommentsAndBlankLinesAreIgnored()
    {
        var edited = Code.Replace("public void M()", "public void M() // does things").Replace("    public void Other()", "\n    /// <summary>Other.</summary>\n    public void Other()").Replace("Local();", "Local();   ");
        Assert.Empty(Map(Code, edited));
    }

    [Fact]
    public void UsingChangeIsFileLevel()
    {
        var change = Assert.Single(Map(Code, Code.Replace("using System;", "using System;\nusing System.Text;")));
        Assert.Equal(ChangeReason.FileChanged, change.Reason);
    }

    [Fact]
    public void DetectsDiServiceCollectionExtensions()
    {
        Assert.True(FallbackPlanner.ContainsServiceCollectionExtension("static class X { public static IServiceCollection AddX(this IServiceCollection s) => s; }"));
        Assert.True(FallbackPlanner.ContainsServiceCollectionExtension("static class X { public static void AddX(this Microsoft.Extensions.DependencyInjection.IServiceCollection s) { } }"));
        Assert.False(FallbackPlanner.ContainsServiceCollectionExtension("class X { void M(IServiceCollection s) { } }"));
    }
}

public sealed class ReferenceUsageTests
{
    [Theory]
    [InlineData("var a = o.P;", ReferenceUsage.Read)]
    [InlineData("o.P = 1;", ReferenceUsage.Write)]
    [InlineData("o.P += 1;", ReferenceUsage.ReadWrite)]
    [InlineData("o.P++;", ReferenceUsage.ReadWrite)]
    [InlineData("var x = new O { P = 1 };", ReferenceUsage.Write)]
    [InlineData("(o.P, var y) = (1, 2);", ReferenceUsage.Write)]
    [InlineData("o?.P.ToString();", ReferenceUsage.Read)]
    [InlineData("P = 3;", ReferenceUsage.Write)]
    public void ClassifiesPropertyUsage(string statement, ReferenceUsage expected)
    {
        var code = "class O { public int P { get; set; } void M(O o) { " + statement + " } }";
        var tree = CSharpSyntaxTree.ParseText(code);
        var start = code.IndexOf(statement, StringComparison.Ordinal);
        var index = code.IndexOf("P", start + (statement.StartsWith("var x = new O", StringComparison.Ordinal) ? 13 : 0), StringComparison.Ordinal);
        Assert.Equal(expected, ReferenceCache.ClassifyUsage(tree.GetRoot(), new TextSpan(index, 1)));
    }
}
