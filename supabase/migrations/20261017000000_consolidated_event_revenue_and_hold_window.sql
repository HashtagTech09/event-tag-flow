-- 1. Consolidated event revenue
-- ---------------------------------------------------------------------------
-- The admin report used to treat "Cash collected" as a third revenue stream next
-- to Ticket and Coin revenue, even though every cash order is already counted in
-- one of those two. Revenue is partitioned once, here, by booking_source:
--   ticket_revenue_inr  = paid landing-page orders
--   coin_revenue_inr    = paid coins_page orders
--   recognised_revenue_inr = ticket + coin (never more than the paid gross)
-- payment_method is a breakdown of that same money, never an addend.
-- security_invoker: admin RLS on event_orders decides who sees rows. The
-- paid/hold predicates are inlined (same rule as event_order_is_paid /
-- event_order_hold_is_live) because those helpers are not executable by app roles.
DROP VIEW IF EXISTS public.view_consolidated_event_revenue;
CREATE VIEW public.view_consolidated_event_revenue WITH (security_invoker = true) AS
WITH orders AS (
  SELECT
    o.*,
    COALESCE(o.payment_status, 'pending') IN ('paid', 'completed') AS paid,
    COALESCE(o.payment_status, 'pending') IN ('pending', 'manual_payment') AS pending
  FROM public.event_orders o
)
SELECT
  o.id AS order_id,
  o.created_at,
  o.paid_at,
  (o.created_at AT TIME ZONE 'Asia/Kolkata')::date AS order_date_ist,
  COALESCE(o.payment_status, 'pending') AS payment_status,
  COALESCE(NULLIF(lower(trim(o.payment_provider)), ''), 'manual') AS payment_method,
  o.booking_source,
  o.parent_order_id,
  o.paid AS is_paid,
  o.pending AS is_pending,
  (o.pending AND COALESCE(o.checkout_token_expires_at, o.created_at + INTERVAL '15 minutes') > now()) AS hold_is_live,
  COALESCE(o.total_amount_inr, 0)::NUMERIC(12,2) AS gross_amount_inr,
  CASE WHEN o.paid AND o.booking_source IS DISTINCT FROM 'coins_page'
    THEN COALESCE(o.total_amount_inr, 0) ELSE 0 END::NUMERIC(12,2) AS ticket_revenue_inr,
  CASE WHEN o.paid AND o.booking_source = 'coins_page'
    THEN COALESCE(o.total_amount_inr, 0) ELSE 0 END::NUMERIC(12,2) AS coin_revenue_inr,
  CASE WHEN o.paid THEN COALESCE(o.total_amount_inr, 0) ELSE 0 END::NUMERIC(12,2) AS recognised_revenue_inr,
  COALESCE(
    (SELECT array_agg(DISTINCT i.package_key) FROM public.event_order_items i WHERE i.order_id = o.id),
    ARRAY[]::TEXT[]
  ) AS package_keys
FROM orders o;

COMMENT ON VIEW public.view_consolidated_event_revenue IS
  'One row per event order. ticket_revenue_inr + coin_revenue_inr = recognised_revenue_inr; payment_method (cash/razorpay/cashfree/manual) is a breakdown of the same money, not an additional stream.';

REVOKE ALL ON public.view_consolidated_event_revenue FROM PUBLIC, anon;
GRANT SELECT ON public.view_consolidated_event_revenue TO authenticated, service_role;

-- Summary RPC: the dashboard tiles, the payment-method breakdown and the
-- package-wise table are all computed here under one set of filters so the
-- client never re-aggregates money.
CREATE OR REPLACE FUNCTION public.get_consolidated_event_revenue(
  p_date_from DATE DEFAULT NULL,
  p_date_to DATE DEFAULT NULL,
  p_package_key TEXT DEFAULT NULL,
  p_payment_status TEXT DEFAULT NULL,
  p_payment_method TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_report JSONB;
BEGIN
  IF auth.uid() IS NULL OR public.get_current_user_role() IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'Admin access required' USING ERRCODE = '42501';
  END IF;

  WITH filtered AS MATERIALIZED (
    SELECT r.*
    FROM public.view_consolidated_event_revenue r
    WHERE (p_date_from IS NULL OR r.order_date_ist >= p_date_from)
      AND (p_date_to IS NULL OR r.order_date_ist <= p_date_to)
      AND (NULLIF(p_payment_status, '') IS NULL OR r.payment_status = p_payment_status)
      AND (NULLIF(p_payment_method, '') IS NULL OR r.payment_method = lower(trim(p_payment_method)))
      AND (NULLIF(p_package_key, '') IS NULL OR p_package_key = ANY (r.package_keys))
  ), totals AS (
    SELECT
      COUNT(*) AS total_orders,
      COUNT(*) FILTER (WHERE is_paid) AS successful_payments,
      COUNT(*) FILTER (WHERE is_pending) AS pending_payments,
      COALESCE(SUM(ticket_revenue_inr), 0) AS ticket_revenue_inr,
      COALESCE(SUM(coin_revenue_inr), 0) AS coin_revenue_inr,
      COALESCE(SUM(recognised_revenue_inr), 0) AS recognised_revenue_inr,
      COALESCE(SUM(gross_amount_inr) FILTER (WHERE is_pending), 0) AS pending_amount_inr
    FROM filtered
  ), by_method AS (
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'payment_method', payment_method,
      'orders', orders,
      'paid_orders', paid_orders,
      'revenue_inr', revenue_inr
    ) ORDER BY revenue_inr DESC, payment_method), '[]'::jsonb) AS rows
    FROM (
      SELECT payment_method,
        COUNT(*) AS orders,
        COUNT(*) FILTER (WHERE is_paid) AS paid_orders,
        COALESCE(SUM(recognised_revenue_inr), 0) AS revenue_inr
      FROM filtered
      GROUP BY payment_method
    ) m
  ), by_package AS (
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'package_key', package_key,
      'package_name', package_name,
      'package_category', package_category,
      'quantity', quantity,
      'booking_value_inr', booking_value_inr,
      'revenue_inr', revenue_inr
    ) ORDER BY booking_value_inr DESC, package_key), '[]'::jsonb) AS rows
    FROM (
      SELECT i.package_key,
        MAX(COALESCE(NULLIF(i.package_name, ''), i.package_key)) AS package_name,
        MAX(i.package_category) AS package_category,
        COALESCE(SUM(i.quantity), 0) AS quantity,
        COALESCE(SUM(i.line_total_inr), 0) AS booking_value_inr,
        COALESCE(SUM(i.line_total_inr) FILTER (WHERE f.is_paid), 0) AS revenue_inr
      FROM filtered f
      JOIN public.event_order_items i ON i.order_id = f.order_id
      GROUP BY i.package_key
    ) p
  )
  SELECT jsonb_build_object(
    'generated_at', now(),
    'filters', jsonb_build_object(
      'date_from', p_date_from, 'date_to', p_date_to, 'package_key', NULLIF(p_package_key, ''),
      'payment_status', NULLIF(p_payment_status, ''), 'payment_method', NULLIF(p_payment_method, '')
    ),
    'total_orders', t.total_orders,
    'successful_payments', t.successful_payments,
    'pending_payments', t.pending_payments,
    'ticket_revenue_inr', t.ticket_revenue_inr,
    'coin_revenue_inr', t.coin_revenue_inr,
    'recognised_revenue_inr', t.recognised_revenue_inr,
    'pending_amount_inr', t.pending_amount_inr,
    'by_payment_method', m.rows,
    'by_package', p.rows
  )
  INTO v_report
  FROM totals t, by_method m, by_package p;

  RETURN v_report;
END;
$$;

REVOKE ALL ON FUNCTION public.get_consolidated_event_revenue(DATE, DATE, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_consolidated_event_revenue(DATE, DATE, TEXT, TEXT, TEXT) TO authenticated, service_role;

-- 2. One reservation hold window
-- ---------------------------------------------------------------------------
-- get_event_phase_package_stats still counted a 30-minute hold while
-- get_party_entry_counts, expire_stale_event_orders and checkout all moved to
-- 15 minutes. Phase caps therefore held spots that the party meter had already
-- released. Both now share event_order_hold_is_live (INTERVAL '15 minutes').
CREATE OR REPLACE FUNCTION public.get_event_phase_package_stats()
RETURNS TABLE(
  phase_id UUID,
  package_id TEXT,
  confirmed_quantity BIGINT,
  pending_quantity BIGINT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT
    limits.phase_id,
    limits.package_id,
    COALESCE(
      SUM(items.quantity) FILTER (WHERE public.event_order_is_paid(orders.payment_status)),
      0
    )::BIGINT AS confirmed_quantity,
    COALESCE(
      SUM(items.quantity) FILTER (
        WHERE public.event_order_hold_is_live(orders.payment_status, orders.checkout_token_expires_at, orders.created_at)
      ),
      0
    )::BIGINT AS pending_quantity
  FROM public.event_package_phase_limits limits
  LEFT JOIN public.event_order_items items
    ON items.phase_id = limits.phase_id
    AND items.package_key = limits.package_id
  LEFT JOIN public.event_orders orders
    ON orders.id = items.order_id
  GROUP BY limits.phase_id, limits.package_id;
$$;

REVOKE ALL ON FUNCTION public.get_event_phase_package_stats() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_event_phase_package_stats() TO anon, authenticated, service_role;
