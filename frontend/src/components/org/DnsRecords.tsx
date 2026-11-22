import { Fragment } from 'react';
import { CopyButton } from '../ui/copy-with-confirmation';
import { recordsForIt, type DnsRecord } from '../../lib/selfServeRules';

/** Break only after "." or "-", never mid-label, so IT reads the value the way it is typed. */
function DnsValue({ text }: { text: string }) {
  return <span className="cb-mono cb-dns-value">{text.split(/(?<=[.-])/).map((part, i) => <Fragment key={i}>{i > 0 && <wbr />}<span>{part}</span></Fragment>)}</span>;
}

/** DNS records card: each value copies on its own, plus "Copy all for IT". Values are set in JetBrains Mono. */
export function DnsRecordsCard({ hostname, records }: { hostname: string; records: DnsRecord[] }) {
  return <section className="cb-dns" aria-label={`DNS records for ${hostname}`}>
    <div className="cb-section-head"><h4>DNS records</h4><CopyButton text={recordsForIt(hostname, records)} label="Copy all for IT" copiedLabel="Copied for IT" /></div>
    <div className="cb-table-scroll"><table className="cb-ledger cb-dns-table">
      <thead><tr><th scope="col">Type</th><th scope="col">Name</th><th scope="col">Value</th></tr></thead>
      <tbody>{records.map((r) => <tr key={`${r.type}-${r.name}`}>
        <td className="cb-mono" data-label="Type">{r.type}</td>
        <td data-label="Name"><span className="cb-dns-cell"><DnsValue text={r.name} /><CopyButton text={r.name} label={`Copy ${r.type} name`} compact /></span></td>
        <td data-label="Value"><span className="cb-dns-cell"><DnsValue text={r.value} /><CopyButton text={r.value} label={`Copy ${r.type} value`} compact /></span></td>
      </tr>)}</tbody>
    </table></div>
  </section>;
}
