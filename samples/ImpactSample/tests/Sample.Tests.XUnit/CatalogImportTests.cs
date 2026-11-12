using Sample.Core.Catalog;

namespace Sample.Tests.XUnit;

public class CatalogImportTests : IAsyncLifetime
{
    private ProductCatalog _catalog = new();

    public async Task InitializeAsync()
    {
        using var reader = new StringReader("BOOK;12.50\nPEN;1.20\n");
        _catalog = await CatalogImporter.ImportAsync(reader);
    }

    public Task DisposeAsync() => Task.CompletedTask;

    [Fact]
    public void Import_ReadsAllRows()
    {
        Assert.Equal(2, _catalog.Count);
    }

    [Fact]
    public void Import_ParsesPrices()
    {
        Assert.Equal(1.20m, _catalog.PriceOf("PEN"));
    }
}
