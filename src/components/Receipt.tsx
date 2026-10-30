import { money, num } from '../api';
import { fmtTime } from './ui';

/** Printable sale receipt. */
export function SaleReceipt({ sale }: { sale: any }) {
  return (
    <div className="receipt print-area">
      <h3>{sale.business_name}</h3>
      <p className="center small">Receipt #{sale.number} · {fmtTime(sale.created_at)}</p>
      {sale.customer_name && <p className="center small">Customer: {sale.customer_name}</p>}
      {sale.status === 'voided' && <p className="center" style={{ color: '#b91c1c', fontWeight: 800 }}>CANCELLED — {sale.void_reason}</p>}
      <hr />
      <table>
        <tbody>
          {sale.items.map((i: any) => (
            <tr key={i.id}>
              <td>{i.name}<div className="muted">{num(i.qty)} × {money(i.unit_price)}{i.returned_qty > 0 ? ` · returned ${num(i.returned_qty)}` : ''}</div></td>
              <td className="num">{money(i.line_total)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <hr />
      <table>
        <tbody>
          {sale.discount > 0 && <><tr><td>Subtotal</td><td className="num">{money(sale.subtotal)}</td></tr><tr><td>Discount</td><td className="num">−{money(sale.discount)}</td></tr></>}
          <tr><td><strong>Total</strong></td><td className="num"><strong>{money(sale.total)}</strong></td></tr>
          {sale.payments.map((p: any) => <tr key={p.id}><td>Paid {p.method_name}</td><td className="num">{money(p.amount)}</td></tr>)}
          {sale.credit_amount > 0 && <tr><td><strong>On credit (owed)</strong></td><td className="num"><strong>{money(sale.credit_amount)}</strong></td></tr>}
          {sale.returns?.map((r: any) => <tr key={r.id}><td>Returned ({r.refund_method_name ?? 'off debt'})</td><td className="num">−{money(r.amount)}</td></tr>)}
        </tbody>
      </table>
      <hr />
      <p className="center small">Served by {sale.created_by_name}. Thank you!</p>
    </div>
  );
}
