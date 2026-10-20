-- ============================================================================
-- Finance v2 — correct a purchase's cost (follow-up to 000059).
--
-- 000059's post_usd_purchase() added your share of a USD fee to the batch's
-- cost as fee × supplier rate (e.g. ৳1.26 on a $1,000 Binance buy). No taka
-- left your accounts for it: the principal already paid for dollars that
-- never landed, so the fee's cost was inside principal ÷ net. Counted twice,
-- and a purchase's journal entry (Milestone 2) could not balance.
--
-- Now: cost = BDT principal + your share of BDT (bank) fees — exactly what
-- left your accounts. supplier_rate = principal ÷ (net USD + your share of the
-- USD fees): the per-dollar price you paid for (Assumption 4, priced on net).
-- Same signature, same everything else. src/lib/finance/usd-batch.ts is the
-- same math.
--
-- Data: production had no purchase posted through this function (the UI that
-- calls it was not deployed), so no row needs correcting. Staging test rows
-- posted under 000059 are all reversed.
--
-- MANUAL ROLLBACK: re-run post_usd_purchase() from 000059.
-- ============================================================================

create or replace function public.post_usd_purchase(
  p_actor              uuid,
  p_source_id          uuid,
  p_gross_usd          numeric,
  p_bdt_principal      numeric,
  p_fees               jsonb,
  p_purchased_at       timestamptz,
  p_method             text,
  p_external_reference text,
  p_notes              text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_source      public.usd_sources;
  v_existing    public.usd_purchases;
  v_row         public.usd_purchases;
  v_fee         jsonb;
  v_usd_deduct  numeric := 0;
  v_cap         numeric := 0;
  v_usd_yours   numeric := 0;
  v_net         numeric;
  v_rate        numeric;
  v_later       record;
  v_ref         text := nullif(btrim(coalesce(p_external_reference, '')), '');
begin
  perform public.finance_v2_lock();

  select * into v_source from public.usd_sources where id = p_source_id;
  if not found then raise exception 'NOT_FOUND: Source not found'; end if;
  if not v_source.is_active then
    raise exception 'SOURCE_INACTIVE: That source is deactivated — reactivate it before recording a purchase';
  end if;

  if v_ref is not null then
    select * into v_existing from public.usd_purchases
      where source_id = p_source_id and lower(btrim(external_reference)) = lower(v_ref);
    if found then
      return to_jsonb(v_existing) || jsonb_build_object('duplicate', true);
    end if;
  end if;

  if p_gross_usd is null or p_gross_usd <= 0 or p_gross_usd <> round(p_gross_usd, 2) then
    raise exception 'INVALID_AMOUNT: Enter the USD sent, to the cent';
  end if;
  if p_bdt_principal is null or p_bdt_principal <= 0 or p_bdt_principal <> round(p_bdt_principal, 2) then
    raise exception 'INVALID_AMOUNT: Enter the BDT paid, to the paisa';
  end if;
  if p_purchased_at is null then
    raise exception 'INVALID_DATE: Enter when the purchase happened';
  end if;
  if jsonb_typeof(coalesce(p_fees, '[]'::jsonb)) <> 'array' then
    raise exception 'FEE_INVALID: fees must be a list';
  end if;

  for v_fee in select * from jsonb_array_elements(coalesce(p_fees, '[]'::jsonb)) loop
    if v_fee->>'currency' not in ('BDT', 'USD') or v_fee->>'source' not in ('RULE', 'MANUAL') then
      raise exception 'FEE_INVALID: unknown fee currency or source';
    end if;
    if (v_fee->>'total')::numeric < 0
       or (v_fee->>'your_share')::numeric < 0
       or (v_fee->>'your_share')::numeric > (v_fee->>'total')::numeric then
      raise exception 'FEE_INVALID: your share must be between 0 and the total fee';
    end if;
    if (v_fee->>'total')::numeric - (v_fee->>'your_share')::numeric
       <> coalesce((v_fee->>'counterparty_share')::numeric, -1) then
      raise exception 'FEE_INVALID: shares must add up to the total';
    end if;
    if (v_fee->>'source' = 'MANUAL'
        or (v_fee->>'rule_total')::numeric is distinct from (v_fee->>'total')::numeric)
       and nullif(btrim(coalesce(v_fee->>'reason', '')), '') is null then
      raise exception 'FEE_INVALID: a manual or overridden fee needs a reason';
    end if;
    if v_fee->>'currency' = 'USD' then
      v_usd_deduct := v_usd_deduct + (v_fee->>'total')::numeric;
      v_usd_yours := v_usd_yours + (v_fee->>'your_share')::numeric;
    else
      v_cap := v_cap + (v_fee->>'your_share')::numeric;
    end if;
  end loop;

  v_net := p_gross_usd - v_usd_deduct;
  if v_net <= 0 then raise exception 'BATCH_INVALID: fees exceed the USD received'; end if;
  if v_net <> round(v_net, 2) then
    raise exception 'BATCH_INVALID: USD fees must be whole cents';
  end if;
  -- The price per dollar paid for: the dollars that landed plus your share of
  -- the USD fees. A USD fee is never added to cost as fee × rate (no taka left
  -- for it; its cost is already inside principal ÷ net).
  v_rate := p_bdt_principal / (v_net + v_usd_yours);

  -- Backdating (Assumption 8): nothing dated after this purchase may already
  -- have been drawn from.
  select b.batch_id, b.purchased_at into v_later
  from public.usd_batch_balances b
  where b.status = 'POSTED' and b.used_usd > 0 and b.purchased_at > p_purchased_at
  order by b.purchased_at desc
  limit 1;
  if found then
    raise exception 'BACKDATED_PURCHASE: A purchase dated after this one (%) is already in use. Date it on or after that, or reverse the later usage first', to_char(timezone('Asia/Dhaka', v_later.purchased_at), 'YYYY-MM-DD HH24:MI');
  end if;

  insert into public.usd_purchases (
    source_id, method, usd_amount, bdt_amount, purchased_at, recorded_by, notes,
    gross_usd, net_usd, bdt_principal, fees, capitalized_fees_bdt,
    supplier_rate, effective_rate, rate_warning, external_reference
  ) values (
    p_source_id, nullif(btrim(coalesce(p_method, '')), ''), v_net, p_bdt_principal + v_cap,
    p_purchased_at, p_actor, nullif(btrim(coalesce(p_notes, '')), ''),
    p_gross_usd, v_net, p_bdt_principal, coalesce(p_fees, '[]'::jsonb), v_cap,
    round(v_rate, 6), round((p_bdt_principal + v_cap) / v_net, 6),
    v_rate < 124 or v_rate > 131, v_ref
  )
  returning * into v_row;

  insert into public.platform_finance_audit (actor_id, action, entity_type, entity_id, new_values)
  values (p_actor, 'USD_BATCH_POSTED', 'USD_PURCHASE', v_row.id, jsonb_build_object(
    'source_id', p_source_id, 'gross_usd', p_gross_usd, 'net_usd', v_net,
    'bdt_principal', p_bdt_principal, 'capitalized_fees_bdt', v_cap,
    'total_bdt_cost', v_row.bdt_amount, 'fees', v_row.fees));

  return to_jsonb(v_row) || jsonb_build_object('duplicate', false);
end;
$$;

revoke all on function public.post_usd_purchase(uuid, uuid, numeric, numeric, jsonb, timestamptz, text, text, text) from public, anon, authenticated;
grant execute on function public.post_usd_purchase(uuid, uuid, numeric, numeric, jsonb, timestamptz, text, text, text) to service_role;
