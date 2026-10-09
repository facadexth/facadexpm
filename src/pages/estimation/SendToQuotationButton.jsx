// The "ส่งไปใบเสนอราคา" button for the price tab. Hidden unless the tenant has BOTH the estimation and quotations
// modules and the user can edit. Owns the dialog's open state and builds the per-item description context.
import { useMemo, useState } from 'react'
import { useTenant } from '../../hooks/useTenant.js'
import { useUserRole } from '../../hooks/useUserRole.js'
import { canEditPage } from '../../lib/permissions.js'
import { canSendToQuotation } from './sendToQuotationGate.js'
import { resolveItemInputs } from '../../lib/estimationInherit.js'
import { descriptionContext } from './itemForm.js'
import SendToQuotationDialog from './SendToQuotationDialog.jsx'

export default function SendToQuotationButton({ project, items, result, index, templatesById, infillTypesById, packageItems, canEdit, ps = {} }) {
  const { tenant, hasModuleAccess } = useTenant()
  const [open, setOpen] = useState(false)
  const { isAtLeast, role } = useUserRole()
  const allowed = canSendToQuotation({
    canEditEstimation: canEdit, hasEstimation: hasModuleAccess('estimation'), hasQuotations: hasModuleAccess('quotations'),
    isAdmin: isAtLeast('ADMIN'), canEditQuotations: canEditPage(role, 'quotations'),
  })

  const descriptionCtxById = useMemo(() => {
    const out = {}
    if (!allowed || !index || !index.types) return out
    for (const it of items || []) {
      const template = (templatesById || {})[it.template_id] || null
      const resolved = resolveItemInputs(it, project, template, index.types, packageItems)
      out[it.id] = descriptionContext({ item: it, resolved, index, template, infillTypesById })
    }
    return out
  }, [allowed, items, project, index, templatesById, infillTypesById, packageItems])

  if (!allowed) return null
  const linked = !!(ps.link && ps.link.quotation_id)
  return (
    <>
      <button type="button" className="btn btn-primary btn-sm" disabled={!!ps.loading} onClick={() => setOpen(true)}>
        {linked ? 'อัปเดตราคาไปใบเสนอราคา' : 'ส่งไปใบเสนอราคา'}
      </button>
      {open && (
        <SendToQuotationDialog project={project} items={items} result={result} descriptionCtxById={descriptionCtxById}
          link={ps.link} snapshots={ps.snapshots} tenant={tenant}
          onClose={() => setOpen(false)} onDone={() => ps.refetch && ps.refetch()} />
      )}
    </>
  )
}
