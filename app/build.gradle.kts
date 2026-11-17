import java.util.Properties
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val versionProps = Properties().apply { rootProject.file("version.properties").inputStream().use { load(it) } }
val vName: String = versionProps.getProperty("version")
val vCode: Int = vName.split(".").map { it.toInt() }.let { (a, b, c) -> a * 10000 + b * 100 + c }

val localProps = Properties().apply {
    val f = rootProject.file("local.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}
fun secret(env: String, local: String): String? = System.getenv(env)?.takeIf { it.isNotBlank() } ?: localProps.getProperty(local)

android {
    namespace = "io.github.hunther2k.vintview"
    compileSdk = 35

    defaultConfig {
        applicationId = "io.github.hunther2k.vintview"
        minSdk = 26
        targetSdk = 35
        versionCode = vCode
        versionName = vName
        buildConfigField("String", "UPDATE_REPO", "\"hunther2k/vintview\"")
    }

    signingConfigs {
        create("release") {
            val ks = secret("VV_KEYSTORE", "vv.keystore")
            if (ks != null) {
                storeFile = file(ks)
                storePassword = secret("VV_KEYSTORE_PASSWORD", "vv.keystorePassword")
                keyAlias = secret("VV_KEY_ALIAS", "vv.keyAlias") ?: "vintview"
                keyPassword = secret("VV_KEY_PASSWORD", "vv.keyPassword") ?: storePassword
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            val rel = signingConfigs.getByName("release")
            if (rel.storeFile != null) signingConfig = rel
        }
        debug {
            // gleicher Schlüssel wie Release → Test- und echte Fassung lassen sich gegenseitig überinstallieren
            val rel = signingConfigs.getByName("release")
            if (rel.storeFile != null) signingConfig = rel
        }
    }

    buildFeatures { buildConfig = true }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    packaging {
        resources { excludes += "/META-INF/{AL2.0,LGPL2.1}" }
    }

    applicationVariants.all {
        outputs.all {
            (this as com.android.build.gradle.internal.api.BaseVariantOutputImpl).outputFileName =
                "vintview-$vName-${buildType.name}.apk"
        }
    }
}

kotlin {
    compilerOptions { jvmTarget.set(JvmTarget.JVM_17) }
}

dependencies {
    implementation("androidx.core:core:1.13.1")
    implementation("androidx.webkit:webkit:1.12.1")
}
