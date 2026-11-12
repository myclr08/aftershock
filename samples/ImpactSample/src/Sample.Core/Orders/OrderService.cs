using Sample.Core.Pricing;

namespace Sample.Core.Orders;

public sealed class OrderService
{
    private readonly IOrderRepository _repository;
    private readonly PriceCalculator _calculator;

    public OrderService(IOrderRepository repository, PriceCalculator calculator)
    {
        _repository = repository ?? throw new ArgumentNullException(nameof(repository));
        _calculator = calculator ?? throw new ArgumentNullException(nameof(calculator));
    }

    public decimal PlaceOrder(Order order)
    {
        if (order.Lines.Count == 0)
        {
            throw new InvalidOperationException("An order needs at least one line.");
        }

        var total = _calculator.Total(order);
        _repository.Save(order);
        return total;
    }

    public Order? GetOrder(Guid id)
    {
        return _repository.Find(id);
    }
}
