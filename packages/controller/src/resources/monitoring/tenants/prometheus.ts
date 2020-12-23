/**
 * Copyright 2020 Opstrace, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {
  ResourceCollection,
  Service,
  V1PrometheusResource,
  V1ServicemonitorResource,
  ServiceAccount,
  Role,
  RoleBinding,
  withPodAntiAffinityRequired
} from "@opstrace/kubernetes";
import {
  getNodeCount,
  getTenantNamespace,
  getPrometheusName,
  getDomain
} from "../../../helpers";
import { State } from "../../../reducer";
import { Tenant } from "@opstrace/tenants";
import { select } from "@opstrace/utils";
import { KubeConfig } from "@kubernetes/client-node";
import { DockerImages } from "@opstrace/controller-config";

export function PrometheusResources(
  state: State,
  kubeConfig: KubeConfig,
  tenant: Tenant
): ResourceCollection {
  const collection = new ResourceCollection();
  const namespace = getTenantNamespace(tenant);
  const name = getPrometheusName(tenant);

  const config = {
    shards: select(getNodeCount(state), [
      { "<=": 6, choose: 2 },
      {
        "<=": Infinity,
        choose: 3
      }
    ]),
    replicas: 1,
    diskSize: "10Gi",
    resources: {}
  };

  const serviceMonitorSelector = {
    matchLabels: {
      tenant: tenant.name
    }
  };
  let ruleNamespaceSelector = {};
  let serviceMonitorNamespaceSelector = {};

  // https://github.com/prometheus-community/helm-charts/blob/4ac76c1bd53e92b61fe0e8a99c184b35e471cede/charts/kube-prometheus-stack/values.yaml#L1697
  // "Secrets is a list of Secrets in the same namespace as the
  // Prometheus object, which shall be mounted into the Prometheus
  // Pods.The Secrets are mounted into /etc/prometheus/secrets/""
  let promSecrets: string[] = [];
  let promBearerTokenFile: string | undefined = undefined;

  const remoteWrite: { url: string; bearerTokenFile?: string } = {
    url: `http://cortex-api.${getTenantNamespace(
      tenant
    )}.svc.cluster.local:8080/api/v1/push`
  };

  const remoteRead: { url: string; bearerTokenFile?: string } = {
    url: `http://cortex-api.${getTenantNamespace(
      tenant
    )}.svc.cluster.local:8080/api/v1/read`
  };

  if (tenant.type !== "SYSTEM") {
    ruleNamespaceSelector = serviceMonitorNamespaceSelector = {
      matchLabels: {
        tenant: tenant.name
      }
    };
  } else {
    // For the system tenant's Prometheus -- which scrapes Opstrace system
    // targets and pushes system metrics into Cortex via Prom's remote_write
    // protocol -- use the bearer_token_file mechanism to authenticate POST
    // requests towards the authenticator built into the Cortex API proxy.
    promSecrets = ["system-tenant-api-auth-token"];
    promBearerTokenFile =
      "/etc/prometheus/secrets/system-tenant-api-auth-token/system_tenant_api_auth_token";

    remoteWrite.bearerTokenFile = promBearerTokenFile;
    remoteRead.bearerTokenFile = promBearerTokenFile;
  }

  collection.add(
    new Service(
      {
        apiVersion: "v1",
        kind: "Service",
        metadata: {
          labels: {
            prometheus: name,
            app: "prometheus"
          },
          name: "prometheus",
          namespace
        },
        spec: {
          ports: [
            {
              name: "web",
              port: 9090,
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              targetPort: "web" as any
            }
          ],
          selector: {
            app: "prometheus",
            prometheus: name
          },
          sessionAffinity: "ClientIP"
        }
      },
      kubeConfig
    )
  );

  collection.add(
    new V1ServicemonitorResource(
      {
        apiVersion: "monitoring.coreos.com/v1",
        kind: "ServiceMonitor",
        metadata: {
          labels: {
            app: "prometheus",
            prometheus: name,
            tenant: "system"
          },
          name: "prometheus",
          namespace
        },
        spec: {
          jobLabel: "prometheus",
          endpoints: [
            {
              interval: "30s",
              port: "web",
              path: "/prometheus/metrics"
            }
          ],
          selector: {
            matchLabels: {
              app: "prometheus"
            }
          }
        }
      },
      kubeConfig
    )
  );

  //
  // "Image if specified has precedence over baseImage, tag and sha
  // combinations. Specifying the version is still necessary to ensure the
  // Prometheus Operator knows what version of Thanos is being configured."
  //
  // https://docs.openshift.com/container-platform/4.4/rest_api/monitoring_apis/prometheus-monitoring-coreos-com-v1.html
  //
  // Get the deployed version from the base image. This ensures image and
  // version parameters are always in sync.
  //
  const prometheusVersion = DockerImages.prometheus.split(":")[1];

  collection.add(
    new V1PrometheusResource(
      {
        apiVersion: "monitoring.coreos.com/v1",
        kind: "Prometheus",
        metadata: {
          labels: {
            prometheus: name
          },
          name,
          namespace
        },
        spec: {
          externalUrl: `https://system.${getDomain(state)}/prometheus`,
          routePrefix: "/prometheus",
          affinity: withPodAntiAffinityRequired({
            prometheus: name
          }),
          storage: {
            volumeClaimTemplate: {
              spec: {
                storageClassName: "pd-ssd",
                accessModes: ["ReadWriteOnce"],
                resources: {
                  requests: {
                    storage: config.diskSize
                  }
                }
              }
            }
          },
          alerting: {
            alertmanagers: [
              {
                name: `alertmanager`, // This is the alertmanager svc
                pathPrefix: "/alertmanager",
                namespace,
                port: "web"
              }
            ]
          },
          remoteWrite: [remoteWrite],
          remoteRead: [remoteRead],
          image: DockerImages.prometheus,
          nodeSelector: {
            "kubernetes.io/os": "linux"
          },
          podMonitorSelector: {},
          probeNamespaceSelector: {},
          probeSelector: {},
          replicas: config.replicas,
          //
          // "To run Prometheus in a highly available manner, two (or more)
          // instances need to be running with the same configuration, that
          // means they scrape the same targets, which in turn means they will
          // have the same data in memory and on disk, which in turn means they
          // are answering requests the same way. In reality this is not
          // entirely true, as the scrape cycles can be slightly different, and
          // therefore the recorded data can be slightly different. This means
          // that single requests can differ slightly. What all of the above
          // means for Prometheus is that there is a problem when a single
          // Prometheus instance is not able to scrape the entire infrastructure
          // anymore. This is where Prometheus' sharding feature comes into
          // play. It divides the targets Prometheus scrapes into multiple
          // groups, small enough for a single Prometheus instance to scrape. If
          // possible functional sharding is recommended. What is meant by
          // functional sharding is that all instances of Service A are being
          // scraped by Prometheus A"
          //
          // https://github.com/prometheus-operator/prometheus-operator/blob/02a5bac9610299372e9f77cbbe0c824ce636795b/Documentation/high-availability.md#prometheus
          //
          //
          // Not much docs on enabling sharding besides this issue
          // https://github.com/prometheus-operator/prometheus-operator/issues/3130#issuecomment-610506794
          // and the PR
          // https://github.com/prometheus-operator/prometheus-operator/pull/3241
          //
          shards: config.shards,
          resources: config.resources,
          secrets: promSecrets,
          ruleNamespaceSelector,
          ruleSelector: {
            matchLabels: {
              prometheus: name,
              role: "alert-rules"
            }
          },
          securityContext: {
            fsGroup: 2000,
            runAsNonRoot: true,
            runAsUser: 1000
          },
          serviceAccountName: name,
          serviceMonitorNamespaceSelector,
          serviceMonitorSelector,
          version: prometheusVersion
        }
      },
      kubeConfig
    )
  );

  collection.add(
    new ServiceAccount(
      {
        apiVersion: "v1",
        kind: "ServiceAccount",
        metadata: {
          name,
          namespace
        }
      },
      kubeConfig
    )
  );

  collection.add(
    new Role(
      {
        apiVersion: "rbac.authorization.k8s.io/v1",
        kind: "Role",
        metadata: {
          name,
          namespace
        },
        rules: [
          {
            apiGroups: [""],
            resources: ["services", "endpoints", "pods"],
            verbs: ["get", "list", "watch"]
          }
        ]
      },
      kubeConfig
    )
  );
  collection.add(
    new RoleBinding(
      {
        apiVersion: "rbac.authorization.k8s.io/v1",
        kind: "RoleBinding",
        metadata: {
          name,
          namespace
        },
        roleRef: {
          apiGroup: "rbac.authorization.k8s.io",
          kind: "Role",
          name: name
        },
        subjects: [
          {
            kind: "ServiceAccount",
            name,
            namespace
          }
        ]
      },
      kubeConfig
    )
  );

  return collection;
}
