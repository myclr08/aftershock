using Sample.Core.Catalog;

namespace Sample.Tests.XUnit;

public sealed class CatalogFixture
{
    public CatalogFixture()
    {
        Catalog = ProductCatalog.CreateDefault();
    }

    public ProductCatalog Catalog { get; }
}

public class CatalogTests : IClassFixture<CatalogFixture>
{
    private readonly CatalogFixture _fixture;

    public CatalogTests(CatalogFixture fixture)
    {
        _fixture = fixture;
    }

    [Fact]
    public void Default_ContainsBook()
    {
        Assert.Equal(12.50m, _fixture.Catalog.PriceOf("BOOK"));
    }

    [Fact]
    public void Default_HasThreeProducts()
    {
        Assert.Equal(3, _fixture.Catalog.Count);
    }
}
