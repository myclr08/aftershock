using System.Runtime.CompilerServices;
using Aftershock.Analyzer.Workspace;

namespace Aftershock.Analyzer.Tests.Infrastructure;

internal static class MSBuildInitializer
{
    /// <summary>Registers MSBuild before any test touches MSBuildWorkspace.</summary>
    [ModuleInitializer]
    internal static void Initialize()
    {
        MSBuildSetup.Register(SamplePaths.SampleSolutionDirectory);
    }
}
