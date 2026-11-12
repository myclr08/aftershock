namespace Sample.Core.Orders;

public sealed class InMemoryOrderRepository : IOrderRepository
{
    private readonly Dictionary<Guid, Order> _orders = new();

    public InMemoryOrderRepository()
    {
    }

    public InMemoryOrderRepository(IEnumerable<Order> seed)
    {
        foreach (var order in seed)
        {
            _orders[order.Id] = order;
        }
    }

    public int Count => _orders.Count;

    public void Save(Order order)
    {
        _orders[order.Id] = order;
    }

    public Order? Find(Guid id)
    {
        return _orders.TryGetValue(id, out var order) ? order : null;
    }
}
