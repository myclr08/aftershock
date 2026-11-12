namespace Sample.Core.Catalog;

public sealed class ProductCatalog
{
    private readonly Dictionary<string, decimal> _prices = new(StringComparer.OrdinalIgnoreCase);

    public int Count => _prices.Count;

    public static ProductCatalog CreateDefault()
    {
        var catalog = new ProductCatalog();
        catalog.Add("BOOK", 12.50m);
        catalog.Add("PEN", 1.20m);
        catalog.Add("MUG", 8.00m);
        return catalog;
    }

    public void Add(string sku, decimal price)
    {
        _prices[sku] = price;
    }

    public decimal PriceOf(string sku)
    {
        return _prices.TryGetValue(sku, out var price) ? price : throw new KeyNotFoundException(sku);
    }
}
