// "โครงสร้างราคา" tab: factor panel, price table, pies, weights and the project total.
import { useMemo } from 'react'
import { fmt } from '../../lib/supabase.js'
import { priceProject } from '../../lib/priceStructure.js'
import { buildPriceInputs, projectFactors } from '../../lib/priceStructureInputs.js'
import { costPieData, pricePieData, weightSummary, sumproductRow } from '../../lib/priceStructureView.js'
import ProjectFactorsPanel from './ProjectFactorsPanel.jsx'
import PriceStructureTable from './PriceStructureTable.jsx'
import { avgAluPerKg } from './priceStructureTabModel.js'
import PieChart from './PieChart.jsx'
import SendToQuotationButton from './SendToQuotationButton.jsx'

export default function PriceStructureTab({ project, items, costs, infillTypes, canEdit, onProjectSaved, onItemsSaved, actions, index, templatesById, packageItems, ps, addonsLoading = false }) {
  const infillTypesById = useMemo(() => Object.fromEntries((infillTypes || []).map(g => [g.id, g])), [infillTypes])
  const result = useMemo(() => priceProject({ items: buildPriceInputs({ items, costs, project }), factors: projectFactors(project) }), [items, costs, project])
  const w = weightSummary(result.totals)
  const avg = avgAluPerKg(sumproductRow(result.rows, ['alu']).alu, result.totals.aluWeightNet)
  const wastePct = projectFactors(project).wastePct
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <ProjectFactorsPanel project={project} canEdit={canEdit} onSaved={onProjectSaved} />
      <PriceStructureTable items={items} rows={result.rows} costs={costs} infillTypesById={infillTypesById} canEdit={canEdit} onItemsSaved={onItemsSaved}
        total={result.totals.lineTotal}
        actions={<>{actions}<SendToQuotationButton project={project} items={items} result={result} index={index} templatesById={templatesById}
          infillTypesById={infillTypesById} packageItems={packageItems} canEdit={canEdit} ps={ps} addonsLoading={addonsLoading} /></>} />
      <div className="card" style={{ padding: 16, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 16 }}>
        <div>
          <PieChart title="สัดส่วนรวมต้นทุนตามหมวด (SUMPRODUCT ต้นทุน × จำนวน)" data={costPieData(result.rows)} />
          <p style={{ margin: '8px 0 0', fontSize: 12, color: 'var(--text3)' }}>
            น้ำหนักอลูมิเนียมสุทธิรวมทั้งโปรเจกต์ <b className="font-mono">{fmt(w.net)} กก.</b> (นน.ชิ้นงาน × จำนวน) · รวมเผื่อเสียเศษ {wastePct}% = <b className="font-mono">{fmt(w.withWaste)} กก.</b> · ต้นทุนอลูมิเนียมเฉลี่ย <b className="font-mono">{avg === null ? '—' : fmt(avg)}</b> บาท/กก.
          </p>
        </div>
        <PieChart title="สัดส่วนราคาขายต่อชุด × จำนวน (ก่อนปัด)" data={pricePieData(result.totals)} />
      </div>
    </div>
  )
}
