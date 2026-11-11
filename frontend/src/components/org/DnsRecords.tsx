import { CopyButton } from '../ui/copy-with-confirmation';
import { recordsForIt, type DnsRecord } from '../../lib/selfServeRules';

/** DNS records card: each value copies on its own, plus "Copy all for IT". Values are set in JetBrains Mono. */
export function DnsRecordsCard({ hostname, records }: { hostname: string; records: DnsRecord[] }) {
  return <section className="cb-dns" aria-label={`DNS records for ${hostname}`}>
    <div className="cb-section-head"><h4>DNS records</h4><CopyButton text={recordsForIt(hostname, records)} label="Copy all for IT" copiedLabel="Copied for IT" /></div>
    <div className="cb-table-scroll"><table className="cb-ledger cb-dns-table">
      <thead><tr><th scope="col">Type</th><th scope="col">Name</th><th scope="col">Value</th></tr></thead>
      <tbody>{records.map((r) => <tr key={`${r.type}-${r.name}`}>
        <td className="cb-mono">{r.type}</td>
        <td><span className="cb-dns-cell"><span className="cb-mono cb-break">{r.name}</span><CopyButton text={r.name} label={`Copy ${r.type} name`} compact /></span></td>
        <td><span className="cb-dns-cell"><span className="cb-mono cb-break">{r.value}</span><CopyButton text={r.value} label={`Copy ${r.type} value`} compact /></span></td>
      </tr>)}</tbody>
    </table></div>
  </section>;
}
