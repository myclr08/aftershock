namespace Sample.Core.Orders;

public sealed class Order
{
    private readonly List<OrderLine> _lines = new();

    public Order(Customer customer)
    {
        Customer = customer;
        Id = Guid.NewGuid();
    }

    public Guid Id { get; }

    public Customer Customer { get; }

    public IReadOnlyList<OrderLine> Lines => _lines;

    public Order AddLine(string sku, decimal unitPrice, int quantity = 1)
    {
        if (quantity <= 0)
        {
            throw new ArgumentOutOfRangeException(nameof(quantity), "Quantity must be positive.");
        }

        _lines.Add(new OrderLine(sku, unitPrice, quantity));
        return this;
    }
}
