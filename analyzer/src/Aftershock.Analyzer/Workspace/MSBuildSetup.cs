using Microsoft.Build.Locator;

namespace Aftershock.Analyzer.Workspace;

public static class MSBuildSetup
{
    /// <summary>
    /// Registers the MSBuild of the .NET SDK that applies to <paramref name="workingDirectory"/> (honoring its
    /// global.json). Must run before any MSBuild type is loaded. Safe to call more than once.
    /// </summary>
    public static string Register(string workingDirectory)
    {
        if (MSBuildLocator.IsRegistered)
        {
            return "already registered";
        }

        var options = new VisualStudioInstanceQueryOptions
        {
            DiscoveryTypes = DiscoveryType.DotNetSdk,
            WorkingDirectory = workingDirectory,
        };

        var instance = MSBuildLocator.QueryVisualStudioInstances(options).FirstOrDefault();
        if (instance is null)
        {
            var fallback = MSBuildLocator.RegisterDefaults();
            return $"{fallback.Name} {fallback.Version} ({fallback.MSBuildPath}) [default; no SDK resolved for {workingDirectory}]";
        }

        MSBuildLocator.RegisterInstance(instance);
        return $"{instance.Name} {instance.Version} ({instance.MSBuildPath})";
    }
}
