async function installGrafanaDb (context, dbUrl, inputName) {
  await context.$grafanaDashboards.get(dbUrl).then(resp => {
    console.log(dbUrl, resp.data)
    let dashboardCreate = {
      dashboard: resp.data,
      folderId: 0,
      inputs: [{name: inputName, type: "datasource", pluginId: "prometheus", value: "Prometheus"}],
      overwrite: true
    }
    context.$grafanaApi.post(`${context.namespace}_k8s_namespace/api/dashboards/import`, dashboardCreate).then(resp => {
      console.log('创建 dashboard 成功', resp.data)
      context.$notify({
        title: '创建 dashboard 成功',
        message: dbUrl,
        type: 'success',
        duration: 5000
      });
    })
  }).catch(e => {
    context.$message.error(`为 ${context.namespace} 初始化 grafana 失败: ` + e)
  })
}

let addon = {
  enabled: false,
  preFlight: function (context) {
    console.log('preFlight 2 - ' + context.namespace)
    context.$grafanaApi.get(`${context.namespace}_k8s_namespace/api/datasources`).then(async resp => {
      let creatingDatasource = true
      for (let item of resp.data) {
        if (item.url === 'http://monitor-prometheus:9090') {
          creatingDatasource = false
        }
      }
      if (creatingDatasource) {
        let datasource = {
          name: "Prometheus",
          type: "prometheus",
          url: "http://monitor-prometheus:9090",
          orgId: 1,
          access:"proxy",
          basicAuth:false,
          readOnly: false,
          basicAuthPassword: '',
          basicAuthUser: '',
          database: '',
          isDefault: true,
          jsonData: {httpMethod: "GET", keepCookies: []},
          password: '',
          user: '',
          version: 1,
          withCredentials: false
        }
        await context.$grafanaApi.post(`${context.namespace}_k8s_namespace/api/datasources`, datasource).then(resp => {
          context.$notify({
            title: '创建 datasource 成功',
            message: `为 ${context.namespace} 的grafana 创建 prometheus datasource 成功`,
            type: 'success',
            duration: 5000
          });
        }).catch(e => {
          console.error(e)
          context.$message.error('调用 grafana 接口创建 datasource 失败: ' + e)
        })
      } else {
        console.log(`无需为 ${context.namespace} 初始化 grafana prometheus datasource`)
      }
      context.$grafanaApi.get(`${context.namespace}_k8s_namespace/api/search?mode=tree&skipRecent=true&skipStarred=true&starred=false`).then(async resp => {
        let dbs = {
          'db/jvm-micrometer': {
            json: 'scoped/4701.json',
            ds: 'DS_PROMETHEUS'
          },
          'db/mysql-overview': {
            json: 'scoped/7362.json',
            ds: 'DS_PROMETHEUS'
          },
          'db/nginx-vts-stats': {
            json: 'scoped/2949.json',
            ds: 'DS_PROMETHEUS'
          }
        }
        for (let db of resp.data) { // 不再创建已经存在的 dashboard
          console.log(db.uri)
          delete dbs[db.uri]
        }
        for (let i in dbs) {
          await installGrafanaDb(context, dbs[i].json, dbs[i].ds)
        }
        this.enabled = true
      })
    }).catch(e => {
      console.error(e)
      if (e.response && (e.response.status === 404 || e.response.status === 502)) {
        this.$message.warning(`${this.name} 中未安装 eip 监控套件`)
      } else {
        context.$message.error('调用 grafana 接口失败: ' + e)
      }
    })
    // context.$notify({ title: 'monitor-2', message: 'preFlight 2 - ' + context.namespace})
  },
  nodes: [],
  pods: [],
  containers: []
}

// --- containers
async function openJVMMonitor (context) {
  let dashboardUrl = undefined
  let failed = false
  this.loading = true
  await context.$grafanaApi.get(`${context.namespace}_k8s_namespace/api/search?mode=tree&query=JVM&skipRecent=true&skipStarred=true&starred=false`).then(resp => {
    for (let item of resp.data) {
      if (item.uri === 'db/jvm-micrometer') {
        dashboardUrl = item.url
      }
    }
  }).catch(e => {
    context.$message.error('调用 grafana 接口失败: ' + e)
    failed = true
    this.loading = false
  })
  if (failed) return
  if (dashboardUrl === undefined) {
    context.$message.error('未找到 Dashboard: JVM (Micrometer)，请在 grafana 控制台中导入编号为 4701 的 Dashboard')
    this.loading = false
    return
  }
  let start = context.dateFns.getTime(context.dateFns.addHours(new Date(), -12)) / 1000
  let end = context.dateFns.getTime(new Date()) / 1000
  let instance = undefined
  // http://localhost:9080/grafana/pzy-test_k8s_namespace/api/datasources/proxy/5/api/v1/series?match[]=jvm_memory_used_bytes%7Bapplication%3D%22SVC-PRODUCT%22%7D&start=1559951596&end=1560037996
  await context.$grafanaApi.get(`${context.namespace}_k8s_namespace/api/datasources/proxy/Prometheus/api/v1/series?match[]=jvm_memory_used_bytes%7Bapplication%3D%22${context.containerName.toUpperCase()}%22%7D&start=${start}&end=${end}`).then(resp => {
    console.log(resp.data)
    for (let item of resp.data.data) {
      if (item.instance.indexOf(context.podIpAddress) === 0) {
        instance = item.instance
        break
      }
    }
  }).catch(e => {
    context.$message.error('调用 grafana 接口失败: ' + e)
    failed = true
    this.loading = false
  })
  if (failed) return
  if (instance === undefined) {
    context.$message.error('grafana 中未找到 12 小时内的监控数据')
    this.loading = false
    return
  }
  let url = `${dashboardUrl}?orgId=1&var-application=${context.containerName.toUpperCase()}&var-instance=${instance}&var-jvm_memory_pool_heap=All&var-jvm_memory_pool_nonheap=All&from=now-1h&to=now&kiosk=tv`
  console.log('openJVMMonitor', url)
  window.open(url, '_blank')
  this.loading = false
}

let JvmMonitor = {
  title: "Java 虚拟机监控",
  loading: false,
  icon: 'el-icon-monitor',
  visible: function (context) {
    // console.log('检查JVM监控是否可见', context)
    return context.containerName.indexOf('svc') === 0 || context.containerName.indexOf('gateway') === 0
  },
  openMonitoringPage: openJVMMonitor
}

addon.containers.push(JvmMonitor)

window.EIP_MONITOR_ADDON_TO_ACTIVATE = addon