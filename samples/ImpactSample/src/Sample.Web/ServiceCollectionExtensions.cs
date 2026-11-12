using Sample.Core.Orders;
using Sample.Core.Pricing;
using Sample.Core.Reporting;

namespace Sample.Web;

public static class ServiceCollectionExtensions
{
    public static IServiceCollection AddShop(this IServiceCollection services, IConfiguration configuration)
    {
        services.Configure<ShopOptions>(configuration.GetSection(ShopOptions.SectionName));
        services.AddSingleton<IOrderRepository, InMemoryOrderRepository>();
        services.AddSingleton<PriceCalculator>();
        services.AddSingleton<OrderService>();
        services.AddSingleton<SalesReport>();
        return services;
    }
}
