using Microsoft.CodeAnalysis;

namespace Aftershock.Analyzer.Engine;

/// <summary>Path and project-graph lookups over one <see cref="Solution"/> snapshot.</summary>
public sealed class SolutionModel
{
    private static readonly (string Assembly, string Framework)[] FrameworkAssemblies =
    {
        ("xunit.core", "xunit"),
        ("xunit.v3.core", "xunit"),
        ("nunit.framework", "nunit"),
        ("Microsoft.VisualStudio.TestPlatform.TestFramework", "mstest"),
        ("MSTest.TestFramework", "mstest"),
    };

    private readonly Solution _solution;
    private readonly Dictionary<string, List<DocumentId>> _documentsByPath;
    private readonly Dictionary<ProjectId, IReadOnlyList<string>> _frameworks = new();
    private readonly ProjectDependencyGraph _graph;

    public SolutionModel(Solution solution)
    {
        _solution = solution;
        _graph = solution.GetProjectDependencyGraph();
        _documentsByPath = new Dictionary<string, List<DocumentId>>(PathUtil.Comparer);
        foreach (var project in solution.Projects)
        {
            foreach (var document in project.Documents)
            {
                if (document.FilePath is null)
                {
                    continue;
                }

                var path = PathUtil.Normalize(document.FilePath);
                if (!_documentsByPath.TryGetValue(path, out var list))
                {
                    _documentsByPath[path] = list = new List<DocumentId>();
                }

                list.Add(document.Id);
            }

            _frameworks[project.Id] = DetectFrameworks(project);
        }
    }

    public Solution Solution => _solution;

    public IReadOnlyList<DocumentId> DocumentsAt(string path)
    {
        return _documentsByPath.TryGetValue(PathUtil.Normalize(path), out var list) ? list : Array.Empty<DocumentId>();
    }

    public IReadOnlyList<string> FrameworksOf(Project project)
    {
        return _frameworks.TryGetValue(project.Id, out var list) ? list : Array.Empty<string>();
    }

    public bool IsTestProject(Project project) => FrameworksOf(project).Count > 0;

    public IEnumerable<Project> TestProjects(Solution solution)
    {
        return solution.Projects.Where(p => _frameworks.TryGetValue(p.Id, out var f) && f.Count > 0);
    }

    /// <summary>Projects whose project file is exactly <paramref name="projectFilePath"/>.</summary>
    public IReadOnlyList<Project> ProjectsWithFile(string projectFilePath)
    {
        return _solution.Projects.Where(p => p.FilePath is not null && PathUtil.PathEquals(PathUtil.Normalize(p.FilePath), PathUtil.Normalize(projectFilePath))).ToList();
    }

    /// <summary>Projects whose directory is the deepest ancestor of <paramref name="path"/> (all target frameworks).</summary>
    public IReadOnlyList<Project> OwningProjects(string path)
    {
        var normalized = PathUtil.Normalize(path);
        var best = new List<Project>();
        var bestLength = -1;
        foreach (var project in _solution.Projects)
        {
            var directory = PathUtil.DirectoryOf(project.FilePath);
            if (directory is null || !PathUtil.IsUnder(normalized, directory))
            {
                continue;
            }

            if (directory.Length > bestLength)
            {
                best.Clear();
                bestLength = directory.Length;
            }

            if (directory.Length == bestLength)
            {
                best.Add(project);
            }
        }

        return best;
    }

    /// <summary>Projects located in <paramref name="directory"/> or below (scope of Directory.Build.props and friends).</summary>
    public IReadOnlyList<Project> ProjectsUnder(string directory)
    {
        var normalized = PathUtil.Normalize(directory);
        return _solution.Projects
            .Where(p => PathUtil.DirectoryOf(p.FilePath) is { } dir && PathUtil.IsUnder(dir, normalized))
            .ToList();
    }

    /// <summary>Test projects among <paramref name="projects"/> and everything that transitively depends on them.</summary>
    public IReadOnlyList<Project> DependentTestProjects(IEnumerable<Project> projects)
    {
        var result = new Dictionary<ProjectId, Project>();
        foreach (var project in projects)
        {
            foreach (var id in _graph.GetProjectsThatTransitivelyDependOnThisProject(project.Id).Append(project.Id))
            {
                var candidate = _solution.GetProject(id);
                if (candidate is not null && IsTestProject(candidate))
                {
                    result[id] = candidate;
                }
            }
        }

        return result.Values.OrderBy(p => p.FilePath, PathUtil.Comparer).ToList();
    }

    /// <summary>The given projects plus everything that transitively depends on them.</summary>
    public IReadOnlyList<Project> WithDependents(IEnumerable<ProjectId> projectIds)
    {
        var ids = new HashSet<ProjectId>();
        foreach (var id in projectIds)
        {
            ids.Add(id);
            foreach (var dependent in _graph.GetProjectsThatTransitivelyDependOnThisProject(id))
            {
                ids.Add(dependent);
            }
        }

        return ids.Select(_solution.GetProject).OfType<Project>().ToList();
    }

    private static IReadOnlyList<string> DetectFrameworks(Project project)
    {
        var frameworks = new SortedSet<string>(StringComparer.Ordinal);
        foreach (var reference in project.MetadataReferences.OfType<PortableExecutableReference>())
        {
            var name = Path.GetFileNameWithoutExtension(reference.FilePath ?? reference.Display ?? string.Empty);
            foreach (var (assembly, framework) in FrameworkAssemblies)
            {
                if (string.Equals(name, assembly, StringComparison.OrdinalIgnoreCase))
                {
                    frameworks.Add(framework);
                }
            }
        }

        return frameworks.ToList();
    }
}
