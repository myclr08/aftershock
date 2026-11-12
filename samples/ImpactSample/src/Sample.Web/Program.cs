using Sample.Core.Orders;
using Sample.Core.Reporting;
using Sample.Web;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddShop(builder.Configuration);

var app = builder.Build();

app.MapGet("/health", () => "ok");
app.MapGet("/report", (SalesReport report) => report.Summarize(Array.Empty<Order>()));

app.Run();
