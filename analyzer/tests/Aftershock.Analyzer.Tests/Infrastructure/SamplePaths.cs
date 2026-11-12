namespace Aftershock.Analyzer.Tests.Infrastructure;

internal static class SamplePaths
{
    /// <summary>Root of the aftershock repository (found by walking up from the test assembly).</summary>
    public static string RepositoryRoot { get; } = FindRepositoryRoot();

    public static string SampleSolutionDirectory => Path.Combine(RepositoryRoot, "samples", "ImpactSample");

    public static string AnalyzerAssembly
    {
        get
        {
            var local = Path.Combine(AppContext.BaseDirectory, "aftershock-analyzer.dll");
            if (File.Exists(local) && File.Exists(Path.Combine(AppContext.BaseDirectory, "aftershock-analyzer.runtimeconfig.json")))
            {
                return local;
            }

            var configuration = new DirectoryInfo(AppContext.BaseDirectory).Parent!.Name;
            return Path.Combine(RepositoryRoot, "analyzer", "src", "Aftershock.Analyzer", "bin", configuration, "net8.0", "aftershock-analyzer.dll");
        }
    }

    private static string FindRepositoryRoot()
    {
        for (var dir = new DirectoryInfo(AppContext.BaseDirectory); dir is not null; dir = dir.Parent)
        {
            if (File.Exists(Path.Combine(dir.FullName, "samples", "ImpactSample", "ImpactSample.sln")))
            {
                return dir.FullName;
            }
        }

        throw new InvalidOperationException("Could not find the repository root (samples/ImpactSample/ImpactSample.sln) above " + AppContext.BaseDirectory);
    }
}
