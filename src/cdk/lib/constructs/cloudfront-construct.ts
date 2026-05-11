import * as cdk from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

export interface CloudFrontConstructProps {
  loadBalancer: elbv2.ApplicationLoadBalancer;
  cfCustomHeaderSecret: secretsmanager.Secret;
  cfCertificateArn: string;
  cfWafArn: string;
  domain: string;
  cfDistributionOriginTimeoutSeconds?: number;
}

export class CloudFrontConstruct extends Construct {
  public readonly distribution: cloudfront.Distribution;

  constructor(scope: Construct, id: string, props: CloudFrontConstructProps) {
    super(scope, id);

    // Create VPC Origin for CloudFront distribution with custom header
    const vpcOrigin = origins.VpcOrigin.withApplicationLoadBalancer(props.loadBalancer, {
      httpsPort: 443,
      originSslProtocols: [cloudfront.OriginSslPolicy.TLS_V1_2],
      protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
      vpcOriginName: 'moodle-alb-vpc-origin',
      customHeaders: {
        'X-Origin-Verify': props.cfCustomHeaderSecret.secretValue.unsafeUnwrap()
      },
      ...(props.cfDistributionOriginTimeoutSeconds && {
        readTimeout: cdk.Duration.seconds(props.cfDistributionOriginTimeoutSeconds)
      })
    });

    // Cache policy for Moodle static assets served via PHP endpoints.
    // These endpoints use revision numbers in the URL for cache busting,
    // so long TTLs are safe — when Moodle updates, the URL changes automatically.
    const moodleStaticCachePolicy = new cloudfront.CachePolicy(this, 'moodle-static-cache-policy', {
      cachePolicyName: `moodle-static-assets-${props.domain.replace(/\./g, '-')}`,
      comment: 'Cache policy for Moodle static assets (CSS, JS, images, fonts)',
      defaultTtl: cdk.Duration.days(7),
      maxTtl: cdk.Duration.days(365),
      minTtl: cdk.Duration.seconds(1),
      enableAcceptEncodingGzip: true,
      enableAcceptEncodingBrotli: true,
      // Include query strings in the cache key — critical for yui_combo.php which
      // uses the query string as the content identifier (e.g. ?rollup/3.18.1/yui-moodlesimple-min.js).
      // Other static paths use slash arguments so this has no negative effect on them.
      queryStringBehavior: cloudfront.CacheQueryStringBehavior.all(),
      headerBehavior: cloudfront.CacheHeaderBehavior.none(),
      cookieBehavior: cloudfront.CacheCookieBehavior.none(),
    });

    // Origin request policy for static assets — forwards the Host header so the
    // ALB can route the request correctly. We use ALL_VIEWER_EXCEPT_HOST_HEADER
    // is not suitable here because the ALB needs the original Host to match its
    // listener rules. Instead we create a custom policy that forwards Host only.
    const staticOriginRequestPolicy = new cloudfront.OriginRequestPolicy(this, 'moodle-static-origin-request-policy', {
      originRequestPolicyName: `moodle-static-orp-${props.domain.replace(/\./g, '-')}`,
      comment: 'Forward Host header for Moodle static assets so ALB routing works',
      headerBehavior: cloudfront.OriginRequestHeaderBehavior.allowList('Host'),
      queryStringBehavior: cloudfront.OriginRequestQueryStringBehavior.all(),
      cookieBehavior: cloudfront.OriginRequestCookieBehavior.none(),
    });

    // Shared behavior config for Moodle static asset paths
    const staticBehavior: cloudfront.BehaviorOptions = {
      origin: vpcOrigin,
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      cachePolicy: moodleStaticCachePolicy,
      originRequestPolicy: staticOriginRequestPolicy,
      allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
      compress: true,
    };

    // Moodle static asset paths that are safe to cache:
    // - theme/styles.php: compiled CSS (revision-keyed)
    // - theme/image.php: theme images/icons (revision-keyed)
    // - theme/font.php: web fonts (revision-keyed)
    // - theme/javascript.php: theme JS (revision-keyed)
    // - theme/yui_combo.php: combined YUI modules
    // - theme/yui_image.php: YUI image assets
    // - theme/jquery.php: jQuery library
    // - lib/javascript.php: core JS (revision-keyed)
    // - lib/requirejs.php: AMD/RequireJS modules
    const staticPaths = [
      '/theme/styles.php/*',
      '/theme/image.php/*',
      '/theme/font.php/*',
      '/theme/javascript.php/*',
      '/theme/yui_combo.php*',
      '/theme/yui_image.php/*',
      '/theme/jquery.php/*',
      '/lib/javascript.php/*',
      '/lib/requirejs.php/*',
    ];

    // Build additionalBehaviors map from static paths
    const additionalBehaviors: Record<string, cloudfront.BehaviorOptions> = {};
    for (const path of staticPaths) {
      additionalBehaviors[path] = staticBehavior;
    }

    // CloudFront distribution with private ALB origin
    // Default behavior passes through uncached (dynamic PHP pages, pluginfile.php, etc.)
    this.distribution = new cloudfront.Distribution(this, 'distribution', {
      comment: `Moodle distribution for ${props.domain}`,
      defaultBehavior: {
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        origin: vpcOrigin,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER
      },
      additionalBehaviors,
      domainNames: [props.domain],
      certificate: acm.Certificate.fromCertificateArn(this, 'cf-cert', props.cfCertificateArn),
      webAclId: props.cfWafArn,
      // Minimise caching of error responses so transient origin failures
      // (e.g. ECS task startup, ALB 502s) don't get stuck in the edge cache.
      errorResponses: [
        { httpStatus: 502, ttl: cdk.Duration.seconds(10) },
        { httpStatus: 503, ttl: cdk.Duration.seconds(10) },
        { httpStatus: 504, ttl: cdk.Duration.seconds(10) },
      ],
    });
  }
}