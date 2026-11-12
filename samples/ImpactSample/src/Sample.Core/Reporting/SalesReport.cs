using Sample.Core.Orders;

namespace Sample.Core.Reporting;

public sealed class SalesReport
{
    public string Summarize(IEnumerable<Order> orders)
    {
        var list = orders.ToList();
        return $"{list.Count} orders, {list.Sum(order => order.Lines.Count)} lines";
    }
}
