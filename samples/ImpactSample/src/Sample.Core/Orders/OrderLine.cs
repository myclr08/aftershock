namespace Sample.Core.Orders;

public sealed record OrderLine(string Sku, decimal UnitPrice, int Quantity);
