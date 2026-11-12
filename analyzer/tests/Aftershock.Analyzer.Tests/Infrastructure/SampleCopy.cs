namespace Aftershock.Analyzer.Tests.Infrastructure;

/// <summary>
/// A throw-away copy of samples/ImpactSample inside a fresh git repository. The sample sits in a
/// sub folder (repo/samples/ImpactSample) so the solution is not at the git root.
/// </summary>
internal sealed class SampleCopy : IDisposable
{
    private SampleCopy(string root)
    {
        Root = root;
        RepositoryRoot = Path.Combine(root, "repo");
        SolutionDirectory = Path.Combine(RepositoryRoot, "samples", "ImpactSample");
    }

    public string Root { get; }

    public string RepositoryRoot { get; }

    public string SolutionDirectory { get; }

    public string SolutionPath => Path.Combine(SolutionDirectory, "ImpactSample.sln");

    public static SampleCopy Create(string name)
    {
        var root = Aftershock.Analyzer.Engine.PathUtil.Normalize(Path.Combine(Path.GetTempPath(), "aftershock-tests", $"{name}-{Guid.NewGuid():N}"[..(name.Length + 9)]));
        var copy = new SampleCopy(root);
        CopyDirectory(SamplePaths.SampleSolutionDirectory, copy.SolutionDirectory);
        File.WriteAllText(Path.Combine(copy.RepositoryRoot, ".gitignore"), "bin/\nobj/\nTestResults/\n");
        ProcessRunner.Git(copy.RepositoryRoot, "init", "-q", "-b", "main");
        ProcessRunner.Git(copy.RepositoryRoot, "add", "-A");
        ProcessRunner.Git(copy.RepositoryRoot, "commit", "-q", "-m", "baseline");
        var restore = ProcessRunner.Run("dotnet", copy.SolutionDirectory, "restore", "ImpactSample.sln", "-v", "q", "--disable-build-servers", "-nodeReuse:false");
        if (restore.ExitCode != 0)
        {
            throw new InvalidOperationException("dotnet restore failed: " + restore.Output + restore.Error);
        }

        return copy;
    }

    /// <summary>Absolute path of a file given relative to the solution directory (forward slashes allowed).</summary>
    public string PathOf(string relative) => Path.GetFullPath(Path.Combine(SolutionDirectory, relative.Replace('/', Path.DirectorySeparatorChar)));

    /// <summary>Repository-relative git path of a solution-relative file.</summary>
    public string GitPathOf(string relative) => "samples/ImpactSample/" + relative.Replace('\\', '/');

    public void Dispose()
    {
        try
        {
            Directory.Delete(Root, recursive: true);
        }
        catch (IOException)
        {
        }
        catch (UnauthorizedAccessException)
        {
        }
    }

    private static void CopyDirectory(string source, string target)
    {
        Directory.CreateDirectory(target);
        foreach (var file in Directory.EnumerateFiles(source))
        {
            File.Copy(file, Path.Combine(target, Path.GetFileName(file)));
        }

        foreach (var directory in Directory.EnumerateDirectories(source))
        {
            var name = Path.GetFileName(directory);
            if (name is "bin" or "obj" or "TestResults" or ".vs")
            {
                continue;
            }

            CopyDirectory(directory, Path.Combine(target, name));
        }
    }
}
