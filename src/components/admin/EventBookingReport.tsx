import { useCallback, useEffect, useMemo, useState } from "react";
import { Banknote, CalendarDays, CheckCircle, Coins, Download, FileSpreadsheet, Filter, RefreshCw, Save, Ticket, Timer, Users } from "lucide-react";
import * as XLSX from "xlsx";
import { supabase } from "@/integrations/supabase/client";
import type { Json, Tables } from "@/integrations/supabase/types";
import { EVENT_CATEGORY_LABELS, formatEventPrice } from "@/lib/eventPackages";
import { useToast } from "@/hooks/use-toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

type EventOrderItem = Tables<"event_order_items">;
// `event_order_attendees` is being added alongside this change; its generated type
// lands in types.ts later, so the relation is typed loosely here.
type EventOrderAttendee = { position: number; attendee_name: string; attendee_phone: string };
type EventOrder = Tables<"event_orders"> & {
  event_order_items: EventOrderItem[] | null;
  event_order_attendees?: EventOrderAttendee[] | null;
};

const REPORT_TIME_ZONE = "Asia/Kolkata";
const ORDER_SELECT_WITH_ATTENDEES = "*, event_order_items(*), event_order_attendees(*)";
const ORDER_SELECT_BASIC = "*, event_order_items(*)";

const ALL_PACKAGES = "all-packages";
const ALL_STATUSES = "all-statuses";
const ALL_METHODS = "all-methods";
const PAYMENT_METHOD_LABELS: Record<string, string> = {
  cash: "Cash",
  cashfree: "Cashfree",
  razorpay: "Razorpay",
  manual: "Manual",
};
const SUCCESS_STATUSES = new Set(["paid", "completed"]);
const PENDING_STATUSES = new Set(["pending", "manual_payment"]);
const PAYMENT_STATUSES = ["manual_payment", "pending", "paid", "completed", "failed", "cancelled", "refunded"];

// Mirrors view_consolidated_event_revenue: one row per order, revenue partitioned
// by booking source (ticket vs coin). Payment method is a breakdown of the same money.
type RevenueSummary = {
  total_orders: number;
  successful_payments: number;
  pending_payments: number;
  ticket_revenue_inr: number;
  coin_revenue_inr: number;
  recognised_revenue_inr: number;
  pending_amount_inr: number;
  by_payment_method: Array<{ payment_method: string; orders: number; paid_orders: number; revenue_inr: number }>;
  by_package: Array<{
    package_key: string;
    package_name: string;
    package_category: string;
    quantity: number;
    booking_value_inr: number;
    revenue_inr: number;
  }>;
};

const EMPTY_SUMMARY: RevenueSummary = {
  total_orders: 0,
  successful_payments: 0,
  pending_payments: 0,
  ticket_revenue_inr: 0,
  coin_revenue_inr: 0,
  recognised_revenue_inr: 0,
  pending_amount_inr: 0,
  by_payment_method: [],
  by_package: [],
};

function parseRevenueSummary(value: Json | null): RevenueSummary {
  if (!value || typeof value !== "object" || Array.isArray(value)) return EMPTY_SUMMARY;
  const raw = value as Record<string, Json | undefined>;
  const num = (key: keyof RevenueSummary) => Number(raw[key] ?? 0);
  const list = <T,>(key: keyof RevenueSummary) => (Array.isArray(raw[key]) ? (raw[key] as unknown as T[]) : []);
  return {
    total_orders: num("total_orders"),
    successful_payments: num("successful_payments"),
    pending_payments: num("pending_payments"),
    ticket_revenue_inr: num("ticket_revenue_inr"),
    coin_revenue_inr: num("coin_revenue_inr"),
    recognised_revenue_inr: num("recognised_revenue_inr"),
    pending_amount_inr: num("pending_amount_inr"),
    by_payment_method: list<RevenueSummary["by_payment_method"][number]>("by_payment_method").map((row) => ({
      payment_method: String(row.payment_method || "manual"),
      orders: Number(row.orders || 0),
      paid_orders: Number(row.paid_orders || 0),
      revenue_inr: Number(row.revenue_inr || 0),
    })),
    by_package: list<RevenueSummary["by_package"][number]>("by_package").map((row) => ({
      package_key: String(row.package_key || ""),
      package_name: String(row.package_name || row.package_key || ""),
      package_category: String(row.package_category || ""),
      quantity: Number(row.quantity || 0),
      booking_value_inr: Number(row.booking_value_inr || 0),
      revenue_inr: Number(row.revenue_inr || 0),
    })),
  };
}

// The summary RPC filters on the order's IST calendar date; the order list must agree.
function orderDateIst(createdAt: string | null) {
  if (!createdAt) return "";
  return new Date(createdAt).toLocaleDateString("en-CA", { timeZone: REPORT_TIME_ZONE });
}

function paymentMethod(provider: string | null) {
  return provider?.trim().toLowerCase() || "manual";
}

function paymentMethodLabel(provider: string | null) {
  const method = paymentMethod(provider);
  return PAYMENT_METHOD_LABELS[method] || method.replace(/[_-]/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function titleCaseStatus(status: string | null) {
  return (status || "pending").replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function statusVariant(status: string | null): "default" | "secondary" | "destructive" | "outline" {
  if (SUCCESS_STATUSES.has(status || "")) return "default";
  if (PENDING_STATUSES.has(status || "")) return "secondary";
  if ((status || "") === "cancelled" || (status || "") === "refunded") return "outline";
  return "destructive";
}

function getPackageCategoryLabel(category: string) {
  if (category === "coins") return "Pink'd Coins";
  return EVENT_CATEGORY_LABELS[category as keyof typeof EVENT_CATEGORY_LABELS] || category || "Event";
}

function shortRef(id: string | null | undefined) {
  return id ? id.slice(0, 8).toUpperCase() : "";
}

function isPartyItem(item: EventOrderItem) {
  return item.package_category === "party";
}

function formatPhaseCharged(item: EventOrderItem) {
  if (!isPartyItem(item) || !item.phase_name) return "";
  const price = item.phase_price_inr === null || item.phase_price_inr === undefined ? "" : ` ₹${Number(item.phase_price_inr)}`;
  return `${item.phase_name}${price}`;
}

function getAttendees(order: EventOrder) {
  return [...(order.event_order_attendees || [])].sort((a, b) => a.position - b.position);
}

function formatAttendees(order: EventOrder) {
  return getAttendees(order)
    .map((attendee) => `${attendee.attendee_name} (${attendee.attendee_phone})`)
    .join("; ");
}

function getOrderItems(order: EventOrder) {
  return order.event_order_items || [];
}

function getTimeSlots(value: Json) {
  return Array.isArray(value) ? value.filter((slot): slot is string => typeof slot === "string") : [];
}

function formatTimeSlots(value: Json) {
  const slots = getTimeSlots(value);
  return slots.length > 0 ? slots.join("; ") : "";
}

function getItemsSummary(order: EventOrder) {
  const items = getOrderItems(order);
  if (items.length === 0) return "No items";
  return items
    .map((item) => {
      const slots = formatTimeSlots(item.selected_time_slots);
      return `${item.quantity} x ${item.package_name}${slots ? ` (${slots})` : ""}`;
    })
    .join("; ");
}

function exportCsv(filename: string, headers: string[], rows: Array<Array<string | number>>) {
  const escape = (field: string | number) => {
    const value = String(field ?? "");
    return value.includes(",") || value.includes('"') || value.includes("\n") ? `"${value.replace(/"/g, '""')}"` : value;
  };

  const content = [headers, ...rows].map((row) => row.map(escape).join(",")).join("\n");
  const blob = new Blob(["\uFEFF" + content], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

export default function EventBookingReport() {
  const { toast } = useToast();
  const [orders, setOrders] = useState<EventOrder[]>([]);
  const [summary, setSummary] = useState<RevenueSummary>(EMPTY_SUMMARY);
  const [isLoading, setIsLoading] = useState(true);
  const [isSummaryLoading, setIsSummaryLoading] = useState(true);
  const [updatingOrderId, setUpdatingOrderId] = useState<string | null>(null);
  const [isExpiring, setIsExpiring] = useState(false);
  const [packageFilter, setPackageFilter] = useState(ALL_PACKAGES);
  const [statusFilter, setStatusFilter] = useState(ALL_STATUSES);
  const [methodFilter, setMethodFilter] = useState(ALL_METHODS);
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  const fetchOrders = useCallback(async () => {
    try {
      setIsLoading(true);
      const primary = await supabase
        .from("event_orders")
        .select(ORDER_SELECT_WITH_ATTENDEES)
        .order("created_at", { ascending: false });

      let rows: unknown = primary.data;
      let queryError = primary.error;

      if (primary.error) {
        // The attendees relation may not be deployed yet; fall back to the plain select.
        const fallback = await supabase
          .from("event_orders")
          .select(ORDER_SELECT_BASIC)
          .order("created_at", { ascending: false });
        rows = fallback.data;
        queryError = fallback.error;
      }

      if (queryError) throw queryError;
      setOrders((rows as EventOrder[] | null) || []);
    } catch (error) {
      console.error("Event order report failed:", error);
      toast({
        title: "Event Report Failed",
        description: "Could not load landing-page orders.",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  }, [toast]);

  // Money is totalled in the database (view_consolidated_event_revenue) under the
  // same filters as the list below, so the client never re-adds revenue streams.
  const fetchSummary = useCallback(async () => {
    try {
      setIsSummaryLoading(true);
      const { data, error } = await supabase.rpc("get_consolidated_event_revenue", {
        p_date_from: dateFrom || null,
        p_date_to: dateTo || null,
        p_package_key: packageFilter === ALL_PACKAGES ? null : packageFilter,
        p_payment_status: statusFilter === ALL_STATUSES ? null : statusFilter,
        p_payment_method: methodFilter === ALL_METHODS ? null : methodFilter,
      });
      if (error) throw error;
      setSummary(parseRevenueSummary(data));
    } catch (error) {
      console.error("Event revenue summary failed:", error);
      setSummary(EMPTY_SUMMARY);
      toast({
        title: "Revenue Summary Failed",
        description: "Could not load the consolidated revenue totals.",
        variant: "destructive",
      });
    } finally {
      setIsSummaryLoading(false);
    }
  }, [dateFrom, dateTo, methodFilter, packageFilter, statusFilter, toast]);

  useEffect(() => {
    fetchOrders();
  }, [fetchOrders]);

  useEffect(() => {
    fetchSummary();
  }, [fetchSummary]);

  const refreshAll = useCallback(async () => {
    await Promise.all([fetchOrders(), fetchSummary()]);
  }, [fetchOrders, fetchSummary]);

  const expireStaleHolds = async () => {
    try {
      setIsExpiring(true);
      const { data, error } = await supabase.rpc("expire_stale_event_orders");
      if (error) throw error;
      const cancelled = Number(data ?? 0);
      toast({
        title: "Stale Holds Expired",
        description: `Cancelled ${cancelled} abandoned checkout${cancelled === 1 ? "" : "s"}`,
      });
      await refreshAll();
    } catch (error) {
      console.error("Expire stale holds failed:", error);
      toast({
        title: "Expire Failed",
        description: error instanceof Error ? error.message : "Could not expire stale checkouts.",
        variant: "destructive",
      });
    } finally {
      setIsExpiring(false);
    }
  };

  // Build the package filter from what was actually sold, so coin packs and every real key appear.
  const packageOptions = useMemo(() => {
    const seen = new Map<string, string>();
    orders.forEach((order) => {
      getOrderItems(order).forEach((item) => {
        if (!seen.has(item.package_key)) seen.set(item.package_key, item.package_name || item.package_key);
      });
    });
    return Array.from(seen.entries())
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [orders]);

  const methodOptions = useMemo(() => Array.from(new Set([
    ...Object.keys(PAYMENT_METHOD_LABELS),
    ...orders.map((order) => paymentMethod(order.payment_provider)),
  ])), [orders]);

  const filteredOrders = useMemo(() => {
    return orders.filter((order) => {
      const orderDate = orderDateIst(order.created_at);
      const status = order.payment_status || "pending";
      const packageMatches =
        packageFilter === ALL_PACKAGES || getOrderItems(order).some((item) => item.package_key === packageFilter);
      const statusMatches = statusFilter === ALL_STATUSES || status === statusFilter;
      const methodMatches = methodFilter === ALL_METHODS || paymentMethod(order.payment_provider) === methodFilter;
      const fromMatches = !dateFrom || orderDate >= dateFrom;
      const toMatches = !dateTo || orderDate <= dateTo;
      return packageMatches && statusMatches && methodMatches && fromMatches && toMatches;
    });
  }, [dateFrom, dateTo, orders, packageFilter, statusFilter, methodFilter]);

  const methodBreakdown = useMemo(
    () => summary.by_payment_method.map((row) => ({ ...row, label: paymentMethodLabel(row.payment_method) })),
    [summary.by_payment_method],
  );

  const exportHeaders = [
    "Order ID",
    "Order Ref",
    "Source",
    "Parent Order Ref",
    "Name",
    "Phone",
    "Email",
    "Studio",
    "Cart Items",
    "Packages",
    "Quantities",
    "Sessions",
    "Phase Price Charged",
    "Attendees",
    "Time Slots",
    "Total INR",
    "Payment Provider",
    "Payment Status",
    "Payment Reference",
    "Cashfree Order ID",
    "Cashfree Status",
    "Razorpay Order ID",
    "Razorpay Payment ID",
    "Razorpay Status",
    "Confirmation Email Sent At",
    "Confirmation Email ID",
    "Confirmation Email Error",
    "Paid At",
    "Created At",
  ];

  const exportRows = useMemo(
    () =>
      filteredOrders.map((order) => [
        order.id,
        shortRef(order.id),
        order.booking_source || "",
        shortRef(order.parent_order_id),
        order.customer_name,
        order.customer_phone,
        order.customer_email,
        order.customer_studio || "",
        getItemsSummary(order),
        getOrderItems(order)
          .map((item) => item.package_name || item.package_key)
          .join(" | "),
        getOrderItems(order)
          .map((item) => String(item.quantity))
          .join(" | "),
        getOrderItems(order)
          .map((item) => formatTimeSlots(item.selected_time_slots))
          .join(" | "),
        getOrderItems(order)
          .map(formatPhaseCharged)
          .filter(Boolean)
          .join(" | "),
        formatAttendees(order),
        getOrderItems(order)
          .map((item) => formatTimeSlots(item.selected_time_slots))
          .filter(Boolean)
          .join(" | "),
        Number(order.total_amount_inr || 0),
        order.payment_provider || "manual",
        order.payment_status || "pending",
        order.payment_reference || "",
        order.cashfree_order_id || "",
        order.cashfree_payment_status || order.cashfree_order_status || "",
        order.razorpay_order_id || "",
        order.razorpay_payment_id || "",
        order.razorpay_payment_status || "",
        order.confirmation_email_sent_at || "",
        order.confirmation_email_id || "",
        order.confirmation_email_error || "",
        order.paid_at || "",
        order.created_at,
      ]),
    [filteredOrders],
  );

  const handleExportCsv = () => {
    exportCsv(`pinkd-event-orders-${new Date().toISOString().slice(0, 10)}.csv`, exportHeaders, exportRows);
  };

  const handleExportExcel = () => {
    const worksheet = XLSX.utils.aoa_to_sheet([exportHeaders, ...exportRows]);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "Event Orders");
    XLSX.writeFile(workbook, `pinkd-event-orders-${new Date().toISOString().slice(0, 10)}.xlsx`);
  };

  const updatePaymentStatus = async (orderId: string, paymentStatus: string) => {
    try {
      setUpdatingOrderId(orderId);
      const paidAt = SUCCESS_STATUSES.has(paymentStatus) ? new Date().toISOString() : null;
      const { error } = await supabase
        .from("event_orders")
        .update({ payment_status: paymentStatus, paid_at: paidAt })
        .eq("id", orderId);

      if (error) throw error;

      let emailSent = false;
      let emailError: string | null = null;

      if (SUCCESS_STATUSES.has(paymentStatus)) {
        const { data: emailData, error: confirmationError } = await supabase.functions.invoke(
          "event-confirmation-email",
          {
            body: { event_order_id: orderId },
          },
        );

        emailSent = Boolean(emailData?.confirmation_email_sent);
        emailError = emailData?.confirmation_email_error ? String(emailData.confirmation_email_error) : null;

        if (confirmationError && !emailError) {
          emailError = confirmationError.message;
        }
      }

      setOrders((current) =>
        current.map((order) =>
          order.id === orderId
            ? {
                ...order,
                payment_status: paymentStatus,
                paid_at: paidAt,
                confirmation_email_sent_at: emailSent ? new Date().toISOString() : order.confirmation_email_sent_at,
                confirmation_email_error: emailError,
              }
            : order,
        ),
      );
      void fetchSummary();
      toast({
        title: "Payment Status Updated",
        description: SUCCESS_STATUSES.has(paymentStatus)
          ? emailSent
            ? "The order is paid and the confirmation email was sent."
            : `The order is paid.${emailError ? ` Email failed: ${emailError}` : ""}`
          : "The landing-page order report is up to date.",
      });
    } catch (error) {
      console.error("Payment status update failed:", error);
      toast({
        title: "Update Failed",
        description: "Could not update this order's payment status.",
        variant: "destructive",
      });
    } finally {
      setUpdatingOrderId(null);
    }
  };

  const sendConfirmationEmail = async (orderId: string) => {
    try {
      setUpdatingOrderId(orderId);
      const { data: emailData, error } = await supabase.functions.invoke("event-confirmation-email", {
        body: { event_order_id: orderId },
      });

      const emailSent = Boolean(emailData?.confirmation_email_sent);
      const emailError = emailData?.confirmation_email_error ? String(emailData.confirmation_email_error) : null;

      if (error && !emailError) throw error;

      setOrders((current) =>
        current.map((order) =>
          order.id === orderId
            ? {
                ...order,
                confirmation_email_sent_at: emailSent ? new Date().toISOString() : order.confirmation_email_sent_at,
                confirmation_email_error: emailError,
              }
            : order,
        ),
      );

      toast({
        title: emailSent ? "Confirmation Email Sent" : "Email Not Sent",
        description: emailSent ? "The booking confirmation was sent." : emailError || "The email provider did not send this message.",
        variant: emailSent ? "default" : "destructive",
      });
    } catch (error) {
      console.error("Confirmation email retry failed:", error);
      toast({
        title: "Email Failed",
        description: "Could not send the confirmation email. Check the email provider/API key.",
        variant: "destructive",
      });
    } finally {
      setUpdatingOrderId(null);
    }
  };

  return (
    <Card className="shadow-card">
      <CardHeader>
        <CardTitle className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <span className="flex items-center gap-2">
            <Ticket className="h-5 w-5 text-primary" />
            Event Bookings / Landing Page Report
          </span>
          <span className="text-sm font-normal text-muted-foreground">INR event revenue · ticket and Pink'd Coin orders</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="grid gap-3 md:grid-cols-6">
          <div className="space-y-2 md:col-span-2">
            <Label>Package / Item</Label>
            <Select value={packageFilter} onValueChange={setPackageFilter}>
              <SelectTrigger>
                <SelectValue placeholder="All packages" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL_PACKAGES}>All packages</SelectItem>
                {packageOptions.map((option) => (
                  <SelectItem key={option.id} value={option.id}>
                    {option.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Status</Label>
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger>
                <SelectValue placeholder="All statuses" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL_STATUSES}>All statuses</SelectItem>
                {PAYMENT_STATUSES.map((status) => (
                  <SelectItem key={status} value={status}>
                    {titleCaseStatus(status)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="payment-method-filter">Payment method</Label>
            <Select value={methodFilter} onValueChange={setMethodFilter}>
              <SelectTrigger id="payment-method-filter">
                <SelectValue placeholder="All methods" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL_METHODS}>All methods</SelectItem>
                {methodOptions.map((method) => (
                  <SelectItem key={method} value={method}>{paymentMethodLabel(method)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>From</Label>
            <Input type="date" value={dateFrom} onChange={(event) => setDateFrom(event.target.value)} />
          </div>
          <div className="space-y-2">
            <Label>To</Label>
            <Input type="date" value={dateTo} onChange={(event) => setDateTo(event.target.value)} />
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={refreshAll} disabled={isLoading || isSummaryLoading}>
            <RefreshCw className="mr-2 h-4 w-4" />
            Refresh
          </Button>
          <Button variant="outline" size="sm" onClick={expireStaleHolds} disabled={isExpiring || isLoading}>
            <Timer className="mr-2 h-4 w-4" />
            Expire stale holds
          </Button>
          <Button variant="outline" size="sm" onClick={handleExportCsv} disabled={filteredOrders.length === 0}>
            <Download className="mr-2 h-4 w-4" />
            CSV
          </Button>
          <Button variant="outline" size="sm" onClick={handleExportExcel} disabled={filteredOrders.length === 0}>
            <FileSpreadsheet className="mr-2 h-4 w-4" />
            Excel
          </Button>
        </div>

        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {[
            { label: "Total Orders", value: summary.total_orders.toString(), icon: Users },
            { label: "Ticket revenue", value: formatEventPrice(summary.ticket_revenue_inr), icon: Ticket },
            { label: "Coin revenue", value: formatEventPrice(summary.coin_revenue_inr), icon: Coins },
            { label: "Total revenue (ticket + coin)", value: formatEventPrice(summary.recognised_revenue_inr), icon: Banknote },
            {
              label: `Pending Payments (${formatEventPrice(summary.pending_amount_inr)} on hold)`,
              value: summary.pending_payments.toString(),
              icon: Filter,
            },
            { label: "Successful Payments", value: summary.successful_payments.toString(), icon: CheckCircle },
          ].map((item) => {
            const Icon = item.icon;
            return (
              <div key={item.label} className="rounded-lg border bg-secondary/30 p-4">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm text-muted-foreground">{item.label}</span>
                  <Icon className="h-4 w-4 text-primary" />
                </div>
                <div className="mt-2 text-2xl font-bold">{isSummaryLoading ? "..." : item.value}</div>
              </div>
            );
          })}
        </div>

        <section className="space-y-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Revenue by payment method</h3>
            <span className="text-xs text-muted-foreground">
              Breakdown of total revenue — cash, Razorpay and Cashfree add up to the total, they are not extra streams.
            </span>
          </div>
          {methodBreakdown.length === 0 ? (
            <div className="rounded-lg border bg-secondary/20 p-4 text-sm text-muted-foreground">
              {isSummaryLoading ? "..." : "No payments for these filters."}
            </div>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              {methodBreakdown.map((row) => (
                <div key={row.payment_method} className="rounded-lg border bg-secondary/20 p-4">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-sm font-medium">{row.label}</span>
                    <Badge variant="outline">
                      {row.paid_orders} paid / {row.orders} {row.orders === 1 ? "order" : "orders"}
                    </Badge>
                  </div>
                  <div className="mt-2 text-xl font-bold">{formatEventPrice(row.revenue_inr)}</div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {summary.recognised_revenue_inr > 0
                      ? `${Math.round((row.revenue_inr / summary.recognised_revenue_inr) * 100)}% of total revenue`
                      : "No recognised revenue yet"}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        <div className="grid gap-4 lg:grid-cols-[0.9fr_1.1fr]">
          <section className="space-y-3">
            <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Package-Wise Sales</h3>
            {summary.by_package.length === 0 ? (
              <div className="rounded-lg border bg-secondary/20 p-4 text-sm text-muted-foreground">
                {isSummaryLoading ? "..." : "No package sales for these filters."}
              </div>
            ) : (
              summary.by_package.map((packageData) => (
                <div key={packageData.package_key} className="rounded-lg border bg-secondary/20 p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="font-semibold">{packageData.package_name}</div>
                      <div className="mt-1 text-sm text-muted-foreground">{getPackageCategoryLabel(packageData.package_category)}</div>
                    </div>
                    <Badge variant="outline">Qty {packageData.quantity}</Badge>
                  </div>
                  <div className="mt-3 grid grid-cols-2 gap-3 text-sm">
                    <div>
                      <div className="text-muted-foreground">Booking Value</div>
                      <div className="font-bold">{formatEventPrice(packageData.booking_value_inr)}</div>
                    </div>
                    <div>
                      <div className="text-muted-foreground">Revenue</div>
                      <div className="font-bold text-success">{formatEventPrice(packageData.revenue_inr)}</div>
                    </div>
                  </div>
                </div>
              ))
            )}
          </section>

          <section className="space-y-3">
            <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Recent Orders</h3>
            {filteredOrders.length === 0 ? (
              <div className="rounded-lg border bg-secondary/20 p-4 text-sm text-muted-foreground">No orders match these filters.</div>
            ) : (
              filteredOrders.slice(0, 10).map((order) => (
                <div key={order.id} className="rounded-lg border bg-secondary/20 p-4">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0">
                      <div className="font-semibold">{order.customer_name}</div>
                      <div className="mt-1 text-sm text-muted-foreground">
                        {order.customer_phone} · {order.customer_email}
                      </div>
                      {order.customer_studio ? (
                        <div className="mt-1 text-sm font-medium text-primary">{order.customer_studio}</div>
                      ) : null}
                      {order.parent_order_id ? (
                        <Badge variant="secondary" className="mt-2 gap-1 font-normal">
                          <Coins className="h-3 w-3" />
                          Coins · for order {shortRef(order.parent_order_id)}
                        </Badge>
                      ) : null}
                      <div className="mt-2 space-y-1 text-sm">
                        {getOrderItems(order).map((item) => (
                          <div key={item.id} className="rounded-md bg-background/55 px-2 py-1">
                            <div className="flex items-center justify-between gap-3">
                              <span className="truncate">{item.quantity} x {item.package_name}</span>
                              <span className="shrink-0 font-semibold">{formatEventPrice(Number(item.line_total_inr || 0))}</span>
                            </div>
                            {isPartyItem(item) && item.phase_name ? (
                              <div className="mt-1 text-xs text-muted-foreground">
                                {item.phase_name}
                                {item.phase_price_inr !== null && item.phase_price_inr !== undefined
                                  ? ` · ${formatEventPrice(Number(item.phase_price_inr))} each`
                                  : ""}
                              </div>
                            ) : null}
                            {getTimeSlots(item.selected_time_slots).length > 0 ? (
                              <div className="mt-1 text-xs text-muted-foreground">
                                {formatTimeSlots(item.selected_time_slots)}
                              </div>
                            ) : null}
                          </div>
                        ))}
                      </div>
                    </div>
                    <div className="space-y-2 sm:min-w-44 sm:text-right">
                      <div className="font-bold">{formatEventPrice(Number(order.total_amount_inr || 0))}</div>
                      <Badge variant={statusVariant(order.payment_status)}>{titleCaseStatus(order.payment_status)}</Badge>
                      <div className="text-xs text-muted-foreground">
                        {paymentMethodLabel(order.payment_provider)}
                        {order.cashfree_payment_status || order.razorpay_payment_status
                          ? ` · ${order.cashfree_payment_status || order.razorpay_payment_status}`
                          : ""}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {order.confirmation_email_sent_at
                          ? `Email sent ${new Date(order.confirmation_email_sent_at).toLocaleString("en-IN")}`
                          : order.confirmation_email_error
                            ? `Email failed: ${order.confirmation_email_error}`
                            : "Email not sent yet"}
                      </div>
                      {SUCCESS_STATUSES.has(order.payment_status || "") ? (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="h-8"
                          onClick={() => sendConfirmationEmail(order.id)}
                          disabled={updatingOrderId === order.id}
                        >
                          {order.confirmation_email_sent_at ? "Resend email" : "Send email"}
                        </Button>
                      ) : null}
                      <Select
                        value={order.payment_status || "pending"}
                        onValueChange={(value) => updatePaymentStatus(order.id, value)}
                        disabled={updatingOrderId === order.id}
                      >
                        <SelectTrigger className="h-9">
                          <Save className="mr-2 h-3.5 w-3.5" />
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {PAYMENT_STATUSES.map((status) => (
                            <SelectItem key={status} value={status}>
                              {titleCaseStatus(status)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2 text-xs text-muted-foreground">
                    <span>{shortRef(order.id)}</span>
                    <span>{order.booking_source}</span>
                    {order.payment_reference ? <span>Ref {order.payment_reference}</span> : null}
                    {order.razorpay_order_id ? <span>Razorpay {order.razorpay_order_id}</span> : null}
                    {order.cashfree_order_id ? <span>Cashfree {order.cashfree_order_id}</span> : null}
                    <span className="flex items-center gap-1">
                      <CalendarDays className="h-3 w-3" />
                      {order.created_at ? new Date(order.created_at).toLocaleString("en-IN") : "No date"}
                    </span>
                  </div>
                </div>
              ))
            )}
          </section>
        </div>
      </CardContent>
    </Card>
  );
}
