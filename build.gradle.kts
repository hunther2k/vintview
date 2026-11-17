plugins {
    id("com.android.application") version "8.7.3" apply false
    id("org.jetbrains.kotlin.android") version "2.1.0" apply false
}

// Optional: Build-Ordner außerhalb des Projektordners (local.properties: vv.buildDir=…)
val localProps = java.util.Properties().apply {
    val f = rootProject.file("local.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}
localProps.getProperty("vv.buildDir")?.let { base ->
    allprojects { layout.buildDirectory.set(file("$base/${project.name}")) }
}
