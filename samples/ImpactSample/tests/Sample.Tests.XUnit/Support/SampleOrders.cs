using Sample.Core.Orders;

namespace Sample.Tests.XUnit.Support;

public static class SampleOrders
{
    public static IReadOnlyList<Order> Create()
    {
        var customer = new Customer("c-100", "DE");
        return new[]
        {
            new Order(customer).AddLine("BOOK", 12.50m),
            new Order(customer).AddLine("PEN", 1.20m, 3),
        };
    }

    public static Order SingleItem()
    {
        return new Order(new Customer("c-200", "NL")).AddLine("MUG", 8.00m);
    }
}
