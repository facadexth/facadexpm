export const useTenant = () => ({ tenant: { id: 't1', company_name: 'Test Co' }, loading: false, hasModuleAccess: k => !(window.__noModules || []).includes(k) })
