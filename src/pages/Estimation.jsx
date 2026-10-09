// src/pages/Estimation.jsx
// ============================================================
// Estimation -- projects and their items, each costed live through
// costOpening (catalog prices as of the project's price date). Items are
// added / edited in ItemModal (estimation/ItemModal.jsx). No AI drawing
// extraction yet; doesn't write into quotations or purchase_orders.
// ============================================================
import { useState, useMemo } from 'react'
import { supabase } from '../lib/supabase.js'
import {
  useEstimationProjects, useEstimationOpenings, useBomTemplates, useBomTemplateComponents,
  useBomTemplateHardware, useBomTemplateConstraints, useInfillTypes,
} from '../hooks/useSupabase.js'
import { useUserRole } from '../hooks/useUserRole.js'
import { canEditPage } from '../lib/permissions.js'
import { Modal } from '../components/Modal.jsx'
import { useEstimationCatalog } from '../hooks/useAluCatalog.js'
import { useEstimationSettings, useTemplateJoints, useHardwarePackages, useLayoutTemplates, groupByTemplate } from '../hooks/useEstimation2b.js'
import { listPriceChanges } from '../lib/staleProjectPrices.js'
import { localDateString } from '../lib/localDate.js'
import { typeLabel } from '../lib/typeTree.js'
import ProjectDefaultsPanel from './estimation/ProjectDefaultsPanel.jsx'
import AvailabilityBanner from './estimation/AvailabilityBanner.jsx'
import StalePriceBanner from './estimation/StalePriceBanner.jsx'
import ItemsTable from './estimation/ItemsTable.jsx'
import PriceStructureTab from './estimation/PriceStructureTab.jsx'
import ItemModal from './estimation/ItemModal.jsx'
import QuickQuote from './estimation/QuickQuote.jsx'
import ProjectBomView from './estimation/ProjectBomView.jsx'
import { newProjectRow, packageRowsFor, hardwareBanners, availabilityIssues, costItems, bomsForStale, currentPreviewSigs } from './estimation/projectDefaults.js'

export default function Estimation(props) {
  const { isAtLeast, role } = useUserRole()
  const canEdit = isAtLeast('ADMIN') && canEditPage(role, 'estimation')

  const { data: projects, refetch: refetchProjects } = useEstimationProjects()
  const { data: openings, refetch: refetchOpenings } = useEstimationOpenings()
  const { data: templates } = useBomTemplates()
  const { data: components } = useBomTemplateComponents()
  const { data: hardware } = useBomTemplateHardware()
  const { data: constraints } = useBomTemplateConstraints()
  const { data: infillTypes } = useInfillTypes()
  const { data: layoutTemplates, refetch: refetchLayouts } = useLayoutTemplates()
  const catalog = useEstimationCatalog()
  const { settings } = useEstimationSettings()
  const { data: joints } = useTemplateJoints()
  const hw = useHardwarePackages()

  const [selectedProjectId, setSelectedProjectId] = useState(null)
  const [showProjectForm, setShowProjectForm] = useState(false)
  const [newProjectName, setNewProjectName] = useState('')
  const [itemModal, setItemModal] = useState(null)   // null | { id: string | null }
  const [quickOpen, setQuickOpen] = useState(false)
  const [tab, setTab] = useState('items')   // 'items' | 'bom' | 'price'

  const project = (projects || []).find(p => p.id === selectedProjectId) || null
  const projectOpenings = useMemo(() => (openings || []).filter(o => o.project_id === selectedProjectId), [openings, selectedProjectId])
  const index = catalog.index
  const hwReady = !hw.loading && !hw.error

  // Everything costOpening needs except the item itself; rebuilt only when a source table changes.
  const base = useMemo(() => {
    if (!index || !hwReady) return null
    return {
      templatesById: Object.fromEntries((templates || []).map(t => [t.id, t])),
      componentsByTemplate: groupByTemplate(components), hardwareByTemplate: groupByTemplate(hardware), jointsByTemplate: groupByTemplate(joints),
      typesById: index.types, infillTypesById: Object.fromEntries((infillTypes || []).map(g => [g.id, g])), index, settings,
    }
  }, [index, hwReady, templates, components, hardware, joints, infillTypes, settings])

  const packageItems = useMemo(() => (project ? packageRowsFor(project, hw.items) : null), [project, hw.items])
  const pkg = project && project.hardware_package_id ? hw.packages.find(p => p.id === project.hardware_package_id) : null
  const costCtx = useMemo(() => (base ? { ...base, packageItems } : null), [base, packageItems])
  const today = localDateString(new Date())
  const costs = useMemo(() => (costCtx && project ? costItems({ items: projectOpenings, project, base: costCtx, asOf: project.price_as_of }) : {}), [costCtx, project, projectOpenings])
  const previewSigs = useMemo(() => (costCtx ? currentPreviewSigs({ items: projectOpenings, costs, base: costCtx }) : {}), [costCtx, projectOpenings, costs])
  const stale = useMemo(() => {
    if (!costCtx || !project) return []
    const now = costItems({ items: projectOpenings, project, base: costCtx, asOf: today })
    return listPriceChanges(bomsForStale(costs), bomsForStale(now))
  }, [costCtx, project, projectOpenings, costs, today])

  const issues = useMemo(() => (base && project ? availabilityIssues({ items: projectOpenings, project, templatesById: base.templatesById, index, seriesTypes: catalog.seriesTypes }) : []),
    [base, project, projectOpenings, index, catalog.seriesTypes])
  const hwBanners = useMemo(() => (base && project ? hardwareBanners({ project, pkg, packageItems, items: projectOpenings, templatesById: base.templatesById, typesById: index.types }) : null),
    [base, project, pkg, packageItems, projectOpenings, index])
  const typeNames = useMemo(() => (hwBanners && index ? Object.fromEntries(hwBanners.missingTypeIds.map(id => [id, typeLabel(index.types, id)])) : {}), [hwBanners, index])

  const handleCreateProject = async () => {
    if (!newProjectName.trim()) return
    const { error } = await supabase.from('estimation_projects').insert(newProjectRow(newProjectName, settings))
    if (error) { alert('สร้างไม่สำเร็จ: ' + error.message); return }
    setNewProjectName(''); setShowProjectForm(false); refetchProjects()
  }

  if (catalog.error) return <div className="alert alert-error">โหลดแคตตาล็อกอลูมิเนียมไม่สำเร็จ: {catalog.error}</div>
  if (hw.error) return <div className="alert alert-error">โหลดชุดอุปกรณ์ไม่สำเร็จ: {String(hw.error)}</div>
  if (!index || !base) return <div style={{ color: 'var(--text3)', padding: 20 }}>กำลังโหลดแคตตาล็อก...</div>

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '260px 1fr', gap: 16 }}>
      <div className="card" style={{ padding: 12 }}>
        {canEdit && <button className="btn btn-primary btn-sm" style={{ marginBottom: 10, width: '100%' }} onClick={() => setShowProjectForm(true)}>+ โปรเจกต์ใหม่</button>}
        <div style={{ display: 'grid', gap: 4 }}>
          {(projects || []).map(p => (
            <button key={p.id} className={`btn btn-sm ${selectedProjectId === p.id ? 'btn-primary' : 'btn-ghost'}`} style={{ justifyContent: 'flex-start' }}
              onClick={() => { setSelectedProjectId(p.id); setItemModal(null); setQuickOpen(false) }}>
              {p.name}
            </button>
          ))}
          {!(projects || []).length && <div style={{ fontSize: 12, color: 'var(--text3)', padding: 8 }}>ยังไม่มีโปรเจกต์</div>}
        </div>
      </div>

      <div style={{ minWidth: 0 }}>
        {!project && <div style={{ color: 'var(--text3)', padding: 20 }}>เลือกโปรเจกต์ทางซ้าย หรือสร้างใหม่</div>}
        {project && (
          <div style={{ display: 'grid', gap: 12 }}>
            <ProjectDefaultsPanel project={project} index={index} seriesTypes={catalog.seriesTypes} infillTypes={infillTypes} packages={hw.packages}
              items={projectOpenings} templatesById={base.templatesById} canEdit={canEdit} onSaved={refetchProjects} />
            <AvailabilityBanner issues={issues} hardware={hwBanners} typeNames={typeNames} />
            <StalePriceBanner changes={stale} itemsById={Object.fromEntries(projectOpenings.map(o => [o.id, o]))} index={index} priceAsOf={project.price_as_of}
              projectId={project.id} canEdit={canEdit} onRefreshed={refetchProjects} />
            <div style={{ display: 'flex', gap: 8 }}>
              <button type="button" className={`btn btn-sm ${tab === 'items' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setTab('items')}>รายการ</button>
              <button type="button" className={`btn btn-sm ${tab === 'bom' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setTab('bom')}>BOM ทั้งโครงการ</button>
              <button type="button" className={`btn btn-sm ${tab === 'price' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setTab('price')}>โครงสร้างราคา</button>
              {tab === 'items' && canEdit && <button className="btn btn-primary btn-sm" onClick={() => setItemModal({ id: null })}>+ เพิ่มรายการ</button>}
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setQuickOpen(true)}>ลองคิดราคา</button>
            </div>
            {tab === 'bom' && costCtx && (
              <ProjectBomView key={project.id} project={project} items={projectOpenings} costs={costs} base={costCtx} index={index} seriesTypes={catalog.seriesTypes}
                settings={settings} canEdit={canEdit} onProjectSaved={refetchProjects} />
            )}
            {tab === 'price' && (
              <PriceStructureTab key={project.id} project={project} items={projectOpenings} costs={costs} index={index} infillTypes={infillTypes}
                templatesById={base.templatesById} canEdit={canEdit} onProjectSaved={refetchProjects} onItemsSaved={refetchOpenings} />
            )}
            {tab === 'items' && <ItemsTable items={projectOpenings} costs={costs} previewSigs={previewSigs} project={project} index={index} templatesById={base.templatesById} canEdit={canEdit}
              onOpen={id => setItemModal({ id })} onQuantitySaved={refetchOpenings} />}

            {quickOpen && costCtx && <QuickQuote project={project} ctx={costCtx} templates={templates} seriesTypes={catalog.seriesTypes} today={today} onClose={() => setQuickOpen(false)} />}

            {itemModal && costCtx && (
              <ItemModal key={itemModal.id || 'new'} opening={itemModal.id ? projectOpenings.find(o => o.id === itemModal.id) || null : null}
                project={project} ctx={costCtx} templates={templates} constraints={constraints} infillTypes={infillTypes}
                layoutTemplates={layoutTemplates} seriesTypes={catalog.seriesTypes} currentSig={itemModal.id ? previewSigs[itemModal.id] : null}
                canEdit={canEdit} onClose={() => setItemModal(null)} onLayoutSaved={refetchLayouts}
                onSaved={({ close }) => { refetchOpenings(); if (close) setItemModal(null) }} />
            )}
          </div>
        )}
      </div>

      {showProjectForm && (
        <Modal title="โปรเจกต์ใหม่" onClose={() => setShowProjectForm(false)} maxWidth={420}>
          <div className="modal-body">
            <label className="label">ชื่อโปรเจกต์ ★</label>
            <input className="input" value={newProjectName} onChange={e => setNewProjectName(e.target.value)} placeholder="เช่น บ้านพี่วัฒน์" />
          </div>
          <div className="modal-footer">
            <button className="btn btn-ghost" onClick={() => setShowProjectForm(false)}>ยกเลิก</button>
            <button className="btn btn-primary" disabled={!newProjectName.trim()} onClick={handleCreateProject}>✅ สร้าง</button>
          </div>
        </Modal>
      )}
    </div>
  )
}
