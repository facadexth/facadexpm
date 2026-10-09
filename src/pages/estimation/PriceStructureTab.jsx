// "โครงสร้างราคา" tab: factor panel, price table, pies, weights and the project total.
import { useMemo } from 'react'
import { fmt } from '../../lib/supabase.js'
import { priceProject } from '../../lib/priceStructure.js'
import { buildPriceInputs, projectFactors } from '../../lib/priceStructureInputs.js'
import { costPieData, pricePieData, weightSummary } from '../../lib/priceStructureView.js'
import ProjectFactorsPanel from './ProjectFactorsPanel.jsx'
import PriceStructureTable from './PriceStructureTable.jsx'
import PieChart from './PieChart.jsx'

export default function PriceStructureTab({ project, items, costs, index, infillTypes, templatesById, canEdit, onProjectSaved, onItemsSaved, actions }) { // eslint-disable-line no-unused-vars
  const infillTypesById = useMemo(() => Object.fromEntries((infillTypes || []).map(g => [g.id, g])), [infillTypes])
  const result = useMemo(() => priceProject({ items: buildPriceInputs({ items, costs, project }), factors: projectFactors(project) }), [items, costs, project])
  const w = weightSummary(result.totals)
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <ProjectFactorsPanel project={project} canEdit={canEdit} onSaved={onProjectSaved} />
      <PriceStructureTable items={items} rows={result.rows} costs={costs} infillTypesById={infillTypesById} canEdit={canEdit} onItemsSaved={onItemsSaved} />
      <div className="card" style={{ padding: 16, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 16 }}>
        <PieChart title="สัดส่วนต้นทุนตามหมวด" data={costPieData(result.rows)} />
        <PieChart title="องค์ประกอบราคาขาย" data={pricePieData(result.totals)} />
      </div>
      <div className="card" style={{ padding: 16, display: 'flex', gap: 24, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'space-between' }}>
        <div style={{ display: 'grid', gap: 2, fontSize: 13 }}>
          <div>น้ำหนักอลูมิเนียมสุทธิ: <span className="font-mono">{fmt(w.net)}</span> kg</div>
          <div>รวมเผื่อเสีย: <span className="font-mono">{fmt(w.withWaste)}</span> kg</div>
        </div>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: 12, color: 'var(--text3)' }}>ยอดรวมโครงการ</div>
            <div className="font-mono" style={{ fontSize: 22, fontWeight: 700 }}>{fmt(result.totals.lineTotal)}</div>
          </div>
          {actions}
        </div>
      </div>
    </div>
  )
}
