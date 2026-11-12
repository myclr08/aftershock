using Sample.Core.Orders;
using Sample.Core.Pricing;

namespace Sample.Tests.XUnit;

public class OrderServiceTests
{
    private readonly InMemoryOrderRepository _repository;
    private readonly OrderService _service;

    public OrderServiceTests()
    {
        _repository = new InMemoryOrderRepository();
        _service = new OrderService(_repository, new PriceCalculator());
    }

    [Fact]
    public void PlaceOrder_ReturnsTotalWithTax()
    {
        var order = new Order(new Customer("c-1", "TR")).AddLine("BOOK", 50m);

        Assert.Equal(60m, _service.PlaceOrder(order));
    }

    [Fact]
    public void PlaceOrder_SavesOrder()
    {
        var order = new Order(new Customer("c-1", "DE")).AddLine("PEN", 2m);

        _service.PlaceOrder(order);

        Assert.Equal(1, _repository.Count);
    }

    [Fact]
    public void PlaceOrder_WithoutLines_Throws()
    {
        var order = new Order(new Customer("c-1", "DE"));

        Assert.Throws<InvalidOperationException>(() => _service.PlaceOrder(order));
    }

    [Fact]
    public void GetOrder_UnknownId_ReturnsNull()
    {
        Assert.Null(_service.GetOrder(Guid.NewGuid()));
    }
}
