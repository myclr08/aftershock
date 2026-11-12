using Sample.Core.Orders;

namespace Sample.Tests.NUnit;

internal static class TestOrders
{
    public static Order SingleBook()
    {
        return new Order(new Customer("c-1", "DE")).AddLine("BOOK", 12.50m);
    }

    public static Order WithQuantity(int quantity)
    {
        return new Order(new Customer("c-2", "DE")).AddLine("PEN", 1.20m, quantity);
    }
}
