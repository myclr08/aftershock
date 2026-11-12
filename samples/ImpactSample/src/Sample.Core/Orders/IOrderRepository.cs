namespace Sample.Core.Orders;

public interface IOrderRepository
{
    int Count { get; }

    void Save(Order order);

    Order? Find(Guid id);
}
